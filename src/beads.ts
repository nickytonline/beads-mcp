import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { BeadsError, classifyFailure } from "./errors.ts";
import { makeExecuteBeadsHttp } from "./beads-http.ts";

export type BeadsCommand = (args: string[], actor?: string) => Promise<unknown>;
export type BeadsTransaction = <T>(
  job: (run: BeadsCommand) => Promise<T>,
) => Promise<T>;

/** One queue per process, shared by every stateless MCP request. */
export class BeadsClient {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private stopping = false;

  constructor(private readonly runCommand: BeadsCommand = executeBeads) {}

  transaction: BeadsTransaction = <T>(
    job: (run: BeadsCommand) => Promise<T>,
  ) => {
    // Rejected before any command runs, so no write was attempted.
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
    this.pending++;
    const result = this.tail.then(() => job(this.runCommand));
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
    return result;
  };

  async drain() {
    this.stopping = true;
    await this.tail;
  }
}

// Opt-in: unset (the default) keeps today's per-call `bd` subprocess exec,
// unchanged. Set only when a `bd serve` sidecar + Dolt server mode (--server,
// not the experimental --proxied-server) are actually running — see README
// "Running in HTTP execution mode".
const bdServeUrl = process.env.BD_SERVE_URL;
export const beads = new BeadsClient(
  bdServeUrl
    ? makeExecuteBeadsHttp(bdServeUrl, {
        timeoutMs: process.env.BD_SERVE_TIMEOUT_MS
          ? Number(process.env.BD_SERVE_TIMEOUT_MS)
          : undefined,
        authTokenFile: process.env.BD_SERVE_AUTH_TOKEN_FILE,
      })
    : executeBeads,
);

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
