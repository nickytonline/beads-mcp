import { readFileSync } from "node:fs";
import type { BeadsCommand } from "./beads.ts";
import { BeadsError, classifyHttpFailure } from "./errors.ts";

/**
 * Talks to `bd serve` (bd 1.3.1's persistent HTTP API) instead of forking a
 * `bd` subprocess per call. Every translator below returns the same field
 * shapes `executeBeads`/the real CLI already produce (confirmed against a
 * live `bd serve` + `dolt sql-server` in `--server` mode, not guessed), so
 * `src/tools.ts` and `src/revision.ts` need zero changes regardless of which
 * execution mode is active.
 */

type HttpMethod = "GET" | "POST" | "PATCH";

function parseFlags(tokens: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const token of tokens) {
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    flags[eq === -1 ? token.slice(2) : token.slice(2, eq)] =
      eq === -1 ? "" : token.slice(eq + 1);
  }
  return flags;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Query-DSL values are quoted so multi-word/free text survives parsing. */
function quoteQueryValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

type IssueLike = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrap(result: unknown, key: string): unknown {
  return isRecord(result) && key in result ? result[key] : result;
}

export interface BdServeOptions {
  timeoutMs?: number;
  /** One token per line; only the first non-empty line is used. */
  authTokenFile?: string;
}

export function makeExecuteBeadsHttp(
  baseUrl: string,
  options: BdServeOptions = {},
): BeadsCommand {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const token = options.authTokenFile
    ? readFileSync(options.authTokenFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    : undefined;

  async function call(
    method: HttpMethod,
    path: string,
    write: boolean,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(path, baseUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "TimeoutError";
      throw classifyHttpFailure({ aborted, networkError: !aborted, write });
    }
    const text = await response.text();
    const parsed = text.trim() ? safeJsonParse(text) : null;
    if (!response.ok) {
      throw classifyHttpFailure({
        status: response.status,
        body: isRecord(parsed) ? parsed : undefined,
        write,
      });
    }
    if (parsed === undefined) {
      throw new BeadsError(
        "OUTCOME_UNCERTAIN",
        "Beads serve returned invalid JSON; a write may already have succeeded. Inspect the task before retrying.",
        { retryable: !write, outcomeUnknown: write },
      );
    }
    return parsed;
  }

  function safeJsonParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  async function translateShow(id: string, rest: string[]): Promise<unknown> {
    const flags = parseFlags(rest);
    const includeComments = "include-comments" in flags;
    const path =
      `/v0/beads/issues/${encodeURIComponent(id)}` +
      (includeComments ? "?include_comments=true" : "");
    return call("GET", path, false);
  }

  async function translateReady(rest: string[]): Promise<unknown> {
    const flags = parseFlags(rest);
    const params = new URLSearchParams({ limit: flags.limit ?? "20" });
    if (flags.priority !== undefined) params.set("priority", flags.priority);
    if (flags.label !== undefined) params.set("label", flags.label);
    const result = await call("GET", `/v0/beads/ready?${params}`, false);
    return unwrap(result, "items");
  }

  async function translateSearch(rest: string[]): Promise<unknown> {
    const flags = parseFlags(rest);
    const clauses = [`title=${quoteQueryValue(flags.query ?? "")}`];
    if (flags.status !== undefined && flags.status !== "all") {
      clauses.push(`status=${flags.status}`);
    }
    if (flags.assignee !== undefined) {
      clauses.push(`assignee=${quoteQueryValue(flags.assignee)}`);
    }
    for (const label of splitCsv(flags.label)) {
      clauses.push(`label=${quoteQueryValue(label)}`);
    }
    const params = new URLSearchParams({
      q: clauses.join(" AND "),
      limit: flags.limit ?? "20",
      all: "true", // bd query excludes closed by default; bd search includes it
    });
    const result = await call(
      "GET",
      `/v0/beads/issues%3Aquery?${params}`,
      false,
    );
    return unwrap(result, "items");
  }

  async function translateCreate(
    rest: string[],
    actor: string,
  ): Promise<unknown> {
    const flags = parseFlags(rest);
    const body: IssueLike = { actor, title: flags.title };
    if (flags.description !== undefined) body.description = flags.description;
    if (flags.acceptance !== undefined)
      body.acceptance_criteria = flags.acceptance;
    if (flags.priority !== undefined) body.priority = Number(flags.priority);
    // The CLI defaults an omitted --type to "task"; bd serve does not, and
    // rejects an empty issue_type outright, so replicate the CLI default.
    body.issue_type = flags.type ?? "task";
    const labels = splitCsv(flags.labels);
    if (labels.length) body.labels = labels;
    if (flags.parent !== undefined) body.parent_id = flags.parent;
    const deps = splitCsv(flags.deps);
    if (deps.length) {
      body.dependencies = deps.map((target_id) => ({
        target_id,
        type: "blocks",
      }));
    }
    return call("POST", "/v0/beads/issues", true, body);
  }

  async function translateUpdate(
    id: string,
    rest: string[],
    actor: string,
  ): Promise<unknown> {
    const flags = parseFlags(rest);
    if ("claim" in flags) {
      const result = await call(
        "POST",
        `/v0/beads/issues/${encodeURIComponent(id)}%3Aclaim`,
        true,
        { actor },
      );
      return unwrap(result, "issue");
    }
    if ("assignee" in flags) {
      // The only call site that sets `assignee` is the release/handoff-release
      // shape (`--assignee= --status=open`); `bd serve`'s PATCH rejects a null
      // assignee, so this maps to the dedicated release action instead.
      const result = await call(
        "POST",
        `/v0/beads/issues/${encodeURIComponent(id)}%3Arelease`,
        true,
        { actor },
      );
      return unwrap(result, "issue");
    }
    const patch: IssueLike = {};
    if (flags.title !== undefined) patch.title = flags.title;
    if (flags.description !== undefined) patch.description = flags.description;
    if (flags.acceptance !== undefined)
      patch.acceptance_criteria = flags.acceptance;
    if (flags.priority !== undefined) patch.priority = Number(flags.priority);
    if (flags.status !== undefined) patch.status = flags.status;
    if (
      flags["add-label"] !== undefined ||
      flags["remove-label"] !== undefined
    ) {
      const current = await call(
        "GET",
        `/v0/beads/issues/${encodeURIComponent(id)}`,
        false,
      );
      const currentLabels =
        isRecord(current) && Array.isArray(current.labels)
          ? current.labels.map(String)
          : [];
      const labels = new Set(currentLabels);
      for (const label of splitCsv(flags["add-label"])) labels.add(label);
      for (const label of splitCsv(flags["remove-label"])) labels.delete(label);
      patch.labels = [...labels];
    }
    const result = await call(
      "PATCH",
      `/v0/beads/issues/${encodeURIComponent(id)}`,
      true,
      { actor, patch },
    );
    return unwrap(result, "issue");
  }

  async function translateComments(
    id: string,
    text: string,
    actor: string,
  ): Promise<unknown> {
    return call(
      "POST",
      `/v0/beads/issues/${encodeURIComponent(id)}/comments`,
      true,
      { author: actor, text },
    );
  }

  async function translateDep(
    action: "add" | "remove",
    id: string,
    target: string,
    rest: string[],
    actor: string,
  ): Promise<unknown> {
    if (action === "add") {
      const flags = parseFlags(rest);
      const result = await call("POST", "/v0/beads/dependencies%3Aadd", true, {
        actor,
        edges: [
          { issue_id: id, depends_on_id: target, type: flags.type ?? "blocks" },
        ],
      });
      return unwrap(result, "added");
    }
    const result = await call("POST", "/v0/beads/dependencies%3Aremove", true, {
      actor,
      issue_id: id,
      depends_on_id: target,
    });
    return unwrap(result, "removed");
  }

  async function translateClose(
    id: string,
    rest: string[],
    actor: string,
  ): Promise<unknown> {
    const flags = parseFlags(rest);
    const result = await call(
      "POST",
      `/v0/beads/issues/${encodeURIComponent(id)}%3Aclose`,
      true,
      { actor, reason: flags.reason },
    );
    return unwrap(result, "issue");
  }

  return async function executeBeadsHttp(
    args: string[],
    actor = "mcp",
  ): Promise<unknown> {
    const [subcommand, ...rest] = args;
    switch (subcommand) {
      case "info":
        // Matches executeBeads's READ_COMMANDS, which does not include
        // "info" either: an outcome-uncertain failure here aborts startup
        // rather than being retried, so the distinction has no behavioral
        // effect, but this keeps classification identical across modes.
        return call("GET", "/v0/beads/context", true);
      case "show":
        return translateShow(rest[0] ?? "", rest.slice(1));
      case "ready":
        return translateReady(rest);
      case "search":
        return translateSearch(rest);
      case "create":
        return translateCreate(rest, actor);
      case "update":
        return translateUpdate(rest[0] ?? "", rest.slice(1), actor);
      case "comments":
        // ["comments", "add", id, "--", text]
        return translateComments(rest[1] ?? "", rest[3] ?? "", actor);
      case "dep": {
        // ["dep", "add"|"remove", id, target, ...flags]
        const [action] = rest;
        if (action !== "add" && action !== "remove") {
          throw new BeadsError(
            "INTERNAL",
            `No HTTP translation for "dep ${action}"`,
            { retryable: false },
          );
        }
        return translateDep(
          action,
          rest[1] ?? "",
          rest[2] ?? "",
          rest.slice(3),
          actor,
        );
      }
      case "close":
        return translateClose(rest[0] ?? "", rest.slice(1), actor);
      default:
        throw new BeadsError(
          "INTERNAL",
          `No HTTP translation for bd subcommand "${subcommand}"`,
          { retryable: false },
        );
    }
  };
}
