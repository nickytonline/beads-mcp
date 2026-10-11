import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { BeadsError, classifyFailure } from "./errors.ts";

export type BeadsCommand = (args: string[], actor?: string) => Promise<unknown>;
export type BeadsTransaction = <T>(
  job: (run: BeadsCommand) => Promise<T>,
) => Promise<T>;

const DEFAULT_READ_CONCURRENCY = 8;

function readConcurrencyLimit(): number {
  const raw = process.env.BEADS_READ_CONCURRENCY;
  if (!raw) return DEFAULT_READ_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_READ_CONCURRENCY;
}

/**
 * A counting semaphore used to bound how many read-only `bd` subprocesses
 * run at once. Slots are handed off directly to the next waiter on release,
 * so the internal count never needs adjusting on the handoff path.
 */
class Semaphore {
  #available: number;
  #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = limit;
  }

  acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#available++;
  }
}

/**
 * One queue per process, shared by every stateless MCP request.
 *
 * Writes (`transaction`) are fully serialized: never concurrent with another
 * write, and never concurrent with a read that was already queued ahead of
 * them. Reads (`read`) run with bounded concurrency among themselves, but a
 * read queued after a write must wait for that write to finish first, so no
 * read ever observes state from a write that is only partially applied.
 *
 * This is a readers-writer lock built on promise chaining:
 * - `writeTail` is the completion of the most recently submitted write (or
 *   already resolved if none is pending). Every write waits for it, keeping
 *   writes totally ordered. Every read also waits for it first, so a read
 *   submitted after a write never races ahead of that write.
 * - `pendingReads` holds every read that has been accepted but not yet
 *   finished. A newly submitted write snapshots this set and waits for all
 *   of them before running, so a write never overlaps a read queued ahead of
 *   it. Reads submitted after the write are not in the snapshot, and they
 *   wait on the write via `writeTail` instead - no deadlock.
 */
export class BeadsClient {
  private writeTail: Promise<unknown> = Promise.resolve();
  private readonly pendingReads = new Set<Promise<unknown>>();
  private readonly readSemaphore: Semaphore;
  private pending = 0;
  private stopping = false;

  constructor(
    private readonly runCommand: BeadsCommand = executeBeads,
    readConcurrency: number = readConcurrencyLimit(),
  ) {
    this.readSemaphore = new Semaphore(readConcurrency);
  }

  private rejectIfUnavailable(): Promise<never> | undefined {
    // Rejected before any command runs, so no write or read was attempted.
    if (this.stopping)
      return Promise.reject(
        new BeadsError("BACKEND_UNAVAILABLE", "Server is shutting down", {
          retryable: true,
        }),
      );
    if (this.pending >= 100)
      return Promise.reject(
        new BeadsError(
          "BACKEND_UNAVAILABLE",
          "Beads queue is full; retry later",
          { retryable: true },
        ),
      );
    return undefined;
  }

  /** Fully serialized: never concurrent with another write or a read queued ahead of it. */
  transaction: BeadsTransaction = <T>(
    job: (run: BeadsCommand) => Promise<T>,
  ) => {
    const rejection = this.rejectIfUnavailable();
    if (rejection) return rejection;

    this.pending++;
    const readsAheadOfThisWrite = Promise.allSettled([...this.pendingReads]);
    const previousWrite = this.writeTail;
    const gate = Promise.all([
      previousWrite.catch(() => undefined),
      readsAheadOfThisWrite,
    ]);
    const result = gate.then(() => job(this.runCommand));
    this.writeTail = result
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
    return result;
  };

  /**
   * Bounded concurrent execution for read-only jobs. Waits for any write
   * already queued ahead of it, then runs alongside up to `readConcurrency`
   * other reads - never behind another read, only behind writes.
   */
  read: BeadsTransaction = <T>(job: (run: BeadsCommand) => Promise<T>) => {
    const rejection = this.rejectIfUnavailable();
    if (rejection) return rejection;

    this.pending++;
    const barrier = this.writeTail;
    const result = barrier
      .catch(() => undefined)
      .then(async () => {
        await this.readSemaphore.acquire();
        try {
          return await job(this.runCommand);
        } finally {
          this.readSemaphore.release();
        }
      });
    this.pendingReads.add(result);
    const untrack = () => {
      this.pendingReads.delete(result);
      this.pending--;
    };
    result.then(untrack, untrack);
    return result;
  };

  async drain() {
    this.stopping = true;
    await Promise.allSettled([this.writeTail, ...this.pendingReads]);
  }
}

export const beads = new BeadsClient();

const READ_COMMANDS = new Set(["show", "ready", "search", "list"]);

export function executeBeads(args: string[], actor = "mcp"): Promise<unknown> {
  const write = !READ_COMMANDS.has(args[0] ?? "");
  return new Promise((resolveResult, reject) => {
    const cwd = resolve(process.env.BEADS_PROJECT_DIR ?? ".");
    execFile(
      process.env.BD_BIN ?? "bd",
      ["--json", `--actor=${actor}`, ...args],
      {
        cwd,
        env: {
          ...process.env,
          BEADS_DIR: resolve(process.env.BEADS_DIR ?? resolve(cwd, ".beads")),
        },
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        // stderr is classified into a typed error but never echoed: it and the
        // command arguments may contain user data or secrets.
        if (error) {
          reject(
            classifyFailure({
              stderr,
              code: "code" in error ? error.code : undefined,
              killed: error.killed === true,
              write,
            }),
          );
          return;
        }
        if (!stdout.trim()) {
          resolveResult(null);
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch {
          reject(
            new BeadsError(
              "OUTCOME_UNCERTAIN",
              "Beads returned invalid JSON; a write may already have succeeded. Inspect the task before retrying.",
              { retryable: !write, outcomeUnknown: write },
            ),
          );
        }
      },
    );
  });
}
