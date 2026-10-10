/**
 * Stable, machine-readable failure contract for every tool.
 *
 * Agents branch on `code`, never on the human-readable message. Raw `bd`
 * stderr is classified here but never copied into a message because it may
 * contain user data.
 */
export type BeadsErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "OWNERSHIP_CONFLICT"
  | "REVISION_CONFLICT"
  | "DEPENDENCY_CYCLE"
  | "BACKEND_UNAVAILABLE"
  | "OUTCOME_UNCERTAIN"
  | "INTERNAL";

export interface BeadsErrorOptions {
  /** Safe to resend the identical request without inspecting state first. */
  retryable: boolean;
  /** A write may or may not have been applied. Inspect state before retrying. */
  outcomeUnknown?: boolean;
  details?: Record<string, unknown>;
}

export class BeadsError extends Error {
  readonly code: BeadsErrorCode;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BeadsErrorCode,
    message: string,
    options: BeadsErrorOptions,
  ) {
    super(message);
    this.name = "BeadsError";
    this.code = code;
    this.retryable = options.retryable;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.details = options.details;
  }
}

export interface ErrorPayload {
  error: string;
  code: BeadsErrorCode;
  retryable: boolean;
  outcome_unknown: boolean;
  details?: Record<string, unknown>;
}

export function errorPayload(error: unknown): ErrorPayload {
  if (error instanceof BeadsError) {
    return {
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      outcome_unknown: error.outcomeUnknown,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    code: "INTERNAL",
    retryable: false,
    outcome_unknown: false,
  };
}

export interface FailureInput {
  stderr?: string;
  code?: unknown;
  killed?: boolean;
  write: boolean;
}

/**
 * Maps a failed `bd` invocation to a typed error.
 *
 * The stderr patterns are heuristics. They must be confirmed against the
 * pinned `bd` release by the live test (`npm run test:beads`). Anything that
 * does not match falls through to INTERNAL with an uncertain outcome for
 * writes, which is the safe default.
 */
export function classifyFailure(input: FailureInput): BeadsError {
  const stderr = input.stderr ?? "";
  const { write } = input;

  if (input.code === "ENOENT") {
    return new BeadsError("BACKEND_UNAVAILABLE", "Beads executable not found", {
      retryable: false,
    });
  }
  if (input.killed) {
    return new BeadsError(
      "OUTCOME_UNCERTAIN",
      "Beads command timed out; inspect the task before retrying a write",
      { retryable: !write, outcomeUnknown: write },
    );
  }
  if (/cycle/i.test(stderr)) {
    return new BeadsError(
      "DEPENDENCY_CYCLE",
      "Dependency would create a cycle",
      { retryable: false },
    );
  }
  if (/already (claimed|assigned)|claimed by|assigned to/i.test(stderr)) {
    return new BeadsError(
      "OWNERSHIP_CONFLICT",
      "Task is already claimed by another actor",
      { retryable: false },
    );
  }
  if (
    /not found|no such (issue|task)|does not exist|unknown issue/i.test(stderr)
  ) {
    return new BeadsError("NOT_FOUND", "Task not found", { retryable: false });
  }
  if (
    /unknown flag|invalid (value|argument|priority|status)|usage:/i.test(stderr)
  ) {
    return new BeadsError("INVALID_INPUT", "Beads rejected the input", {
      retryable: false,
    });
  }
  if (
    /locked|busy|connection (refused|reset)|try again|temporar/i.test(stderr)
  ) {
    return new BeadsError(
      "BACKEND_UNAVAILABLE",
      "Beads storage is temporarily unavailable",
      { retryable: !write, outcomeUnknown: write },
    );
  }
  const code = input.code === undefined ? "unknown" : String(input.code);
  return new BeadsError(
    "INTERNAL",
    `Beads command failed (${code}). Check the task state before retrying a write; its outcome may be uncertain.`,
    { retryable: !write, outcomeUnknown: write },
  );
}
