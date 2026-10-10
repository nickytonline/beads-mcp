import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { Effect, Schema } from "effect";
import { beads, type BeadsCommand, type BeadsTransaction } from "./beads.ts";
import { normalizeActor } from "./auth.ts";
import { BeadsError, errorPayload } from "./errors.ts";
import { toMcpSchema } from "./lib/mcp-schema.ts";
import {
  REVISION_PATTERN,
  stateRevision,
  stripLeaseMetadata,
  withRevisions,
  type Issue,
} from "./revision.ts";
import {
  createErrorResult,
  createTextResult,
  runMcpEffect,
} from "./lib/utils.ts";
import { logger } from "./logger.ts";

const text = (description: string) =>
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_000)).annotations(
    { description },
  );
const id = text("Full Beads issue ID").pipe(
  Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
);
const actor = text(
  "Optional compatibility actor; authenticated requests use the verified identity",
).pipe(Schema.maxLength(128), Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/));
const priority = Schema.Int.pipe(Schema.between(0, 4)).annotations({
  description: "Priority: 0 highest, 4 lowest",
});
const status = Schema.Literal(
  "open",
  "in_progress",
  "blocked",
  "deferred",
).annotations({ description: "Task status; use complete to close" });
const limit = Schema.optional(
  Schema.Int.pipe(Schema.between(1, 100)).annotations({
    description: "Maximum results, default 20",
  }),
);
const opt = Schema.optional;
const optionalActor = opt(actor);
const expectedRevision = opt(
  text(
    "state_revision from get. If the task changed since you read it, the write is rejected with REVISION_CONFLICT and nothing is modified. Omit for last-writer-wins.",
  ).pipe(Schema.pattern(REVISION_PATTERN)),
);
const issueFields = {
  title: opt(text("Task title")),
  description: opt(text("Task description")),
  acceptance: opt(text("Acceptance criteria")),
  priority: opt(priority),
};
const outputSchema = toMcpSchema(
  Schema.Struct({
    data: Schema.Unknown.annotations({
      description:
        "Native Beads JSON result; compound operations return named fields",
    }),
  }),
);

function flags(args: Record<string, unknown>, names: string[]): string[] {
  return names.flatMap((name) =>
    args[name] === undefined ? [] : [`--${name}=${String(args[name])}`],
  );
}

function firstIssue(result: unknown): Issue | undefined {
  const issue = Array.isArray(result) ? result[0] : result;
  return issue && typeof issue === "object" ? (issue as Issue) : undefined;
}

function effectiveActor(
  args: { actor?: string },
  authenticatedActor?: string,
): string {
  const value = normalizeActor(authenticatedActor ?? args.actor);
  if (!value) {
    throw new BeadsError(
      "INVALID_INPUT",
      "An authenticated actor is required",
      { retryable: false },
    );
  }
  return value;
}

/** Read the task inside the caller's queue job; absent tasks are NOT_FOUND. */
async function readIssue(
  run: BeadsCommand,
  issueId: string,
  actor?: string,
): Promise<Issue> {
  const issue = firstIssue(await run(["show", issueId], actor));
  if (!issue) {
    throw new BeadsError("NOT_FOUND", "Task not found", {
      retryable: false,
      details: { id: issueId },
    });
  }
  return issue;
}

/**
 * Compare-and-swap check. Runs in the same queue job as the write that
 * follows, so no other request through this process can interleave.
 */
function assertRevision(issue: Issue, expected: string | undefined): void {
  if (expected === undefined) return;
  const current = stateRevision(issue);
  if (current !== expected) {
    throw new BeadsError(
      "REVISION_CONFLICT",
      "Task changed since you read it. Nothing was modified. Re-read with get, reconcile, and retry with the new state_revision.",
      {
        retryable: false,
        details: {
          id: issue.id,
          expected_revision: expected,
          current_revision: current,
          current: {
            title: issue.title,
            description: issue.description,
            priority: issue.priority,
            status: issue.status,
            assignee: issue.assignee ?? null,
            labels: Array.isArray(issue.labels) ? issue.labels : [],
          },
        },
      },
    );
  }
}

function assertOwnedBy(issue: Issue, actor: string, message: string): void {
  if (issue.assignee !== actor) {
    throw new BeadsError("OWNERSHIP_CONFLICT", message, {
      retryable: false,
      details: { id: issue.id, assignee: issue.assignee ?? null },
    });
  }
}

/** A task claimed by someone else cannot be moved or closed by another actor. */
function assertNotClaimedByOther(issue: Issue, actor: string): void {
  if (issue.assignee && issue.assignee !== actor) {
    throw new BeadsError(
      "OWNERSHIP_CONFLICT",
      "Task is claimed by another actor; only the assignee can change its status or complete it",
      {
        retryable: false,
        details: { id: issue.id, assignee: issue.assignee },
      },
    );
  }
}

async function assertOwner(
  run: BeadsCommand,
  issueId: string,
  owner: string,
  expected?: string,
) {
  const issue = await readIssue(run, issueId, owner);
  assertOwnedBy(
    issue,
    owner,
    "Only the current assignee can release or hand off this task",
  );
  assertRevision(issue, expected);
}

/** Keep compound read/write jobs inside the same process-wide queue. */
export function registerTools(
  server: McpServer,
  transaction: BeadsTransaction = beads.transaction,
  authenticatedActor?: string,
): void {
  function register<A extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: Schema.Schema<A, A, never>,
    readOnly: boolean,
    execute: (
      args: A,
      run: BeadsCommand,
      authenticatedActor?: string,
    ) => Promise<unknown>,
    additive = false,
  ) {
    server.registerTool(
      name,
      {
        title: name.replaceAll("_", " "),
        description,
        inputSchema: toMcpSchema(inputSchema),
        outputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !additive,
          openWorldHint: false,
        },
      },
      (args, ctx: ServerContext) =>
        runMcpEffect(
          Effect.gen(function* () {
            const data = yield* Effect.tryPromise({
              try: () =>
                transaction((run) => execute(args, run, authenticatedActor)),
              catch: (error) => error,
            }).pipe(
              Effect.tapError((error) =>
                logger.error(
                  {
                    toolName: name,
                    requestId: ctx.mcpReq.id,
                    code: errorPayload(error).code,
                  },
                  "Tool execution failed",
                ),
              ),
            );
            yield* logger.info(
              { toolName: name, requestId: ctx.mcpReq.id },
              "Tool executed",
            );
            return createTextResult({ data: stripLeaseMetadata(data) });
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(createErrorResult(errorPayload(error))),
            ),
          ),
        ),
    );
  }

  register(
    "ready",
    "Find unblocked tasks to work on. Call claim before starting work.",
    Schema.Struct({
      limit,
      priority: opt(priority),
      label: opt(text("Required label; comma-separated labels use AND")),
    }),
    true,
    (args, run) =>
      run([
        "ready",
        `--limit=${args.limit ?? 20}`,
        ...flags(args, ["priority", "label"]),
      ]),
  );

  register(
    "search",
    "Search tasks, including completed tasks, by text and optional filters.",
    Schema.Struct({
      query: text("Search text"),
      limit,
      status: opt(
        Schema.Literal(
          "open",
          "in_progress",
          "blocked",
          "deferred",
          "closed",
          "all",
        ),
      ),
      assignee: opt(actor),
      label: opt(text("Required labels, comma-separated")),
    }),
    true,
    (args, run) =>
      run([
        "search",
        `--query=${args.query}`,
        `--limit=${args.limit ?? 20}`,
        ...flags(args, ["status", "assignee", "label"]),
      ]),
  );

  register(
    "get",
    "Read task details, dependencies, and comment bodies including handoffs. Adds state_revision (pass as expected_revision to update, release, handoff, or complete), activity_revision and last_activity_at (poll these to detect any change, including notes and labels, which bd's updated_at misses).",
    Schema.Struct({ id }),
    true,
    async (args, run) => {
      const result = await run(["show", args.id, "--include-comments"]);
      if (Array.isArray(result)) {
        if (!result.length)
          throw new BeadsError("NOT_FOUND", "Task not found", {
            retryable: false,
            details: { id: args.id },
          });
        return result.map((issue) => withRevisions(issue as Issue));
      }
      const issue = firstIssue(result);
      if (!issue)
        throw new BeadsError("NOT_FOUND", "Task not found", {
          retryable: false,
          details: { id: args.id },
        });
      return withRevisions(issue);
    },
  );

  register(
    "create",
    "Create a task. Parent creates a subtask; deps lists prerequisite IDs separated by commas.",
    Schema.Struct({
      ...issueFields,
      title: text("Task title"),
      actor: optionalActor,
      type: opt(
        Schema.Literal("task", "bug", "feature", "epic", "chore", "decision"),
      ),
      labels: opt(text("Comma-separated labels")),
      parent: opt(id),
      deps: opt(text("Comma-separated prerequisite IDs")),
    }),
    false,
    (args, run) =>
      run(
        [
          "create",
          ...flags(args, [
            "title",
            "description",
            "acceptance",
            "priority",
            "type",
            "labels",
            "parent",
            "deps",
          ]),
        ],
        effectiveActor(args, authenticatedActor),
      ),
    true,
  );

  register(
    "update",
    "Edit task fields. Pass expected_revision (state_revision from get) for compare-and-swap: a stale value fails with REVISION_CONFLICT and changes nothing. Without it the write is last-writer-wins. Changing status of a task claimed by another actor fails with OWNERSHIP_CONFLICT.",
    Schema.Struct({
      id,
      actor: optionalActor,
      ...issueFields,
      status: opt(status),
      "add-label": opt(text("Comma-separated labels to add")),
      "remove-label": opt(text("Comma-separated labels to remove")),
      expected_revision: expectedRevision,
    }),
    false,
    async (args, run, authenticatedActor) => {
      const writer = effectiveActor(args, authenticatedActor);
      const edits = flags(args, [
        "title",
        "description",
        "acceptance",
        "priority",
        "status",
        "add-label",
        "remove-label",
      ]);
      if (!edits.length)
        throw new BeadsError(
          "INVALID_INPUT",
          "Provide at least one field to update",
          { retryable: false },
        );
      const issue = await readIssue(run, args.id, writer);
      assertRevision(issue, args.expected_revision);
      if (args.status !== undefined) assertNotClaimedByOther(issue, writer);
      return run(["update", args.id, ...edits], writer);
    },
  );

  register(
    "claim",
    "Atomically claim a task as actor and set in_progress. A claim by a different actor fails with OWNERSHIP_CONFLICT. Claims never expire: ownership lasts until release, handoff with release, or complete. Re-claiming your own task is a no-op.",
    Schema.Struct({ id, actor: optionalActor }),
    false,
    (args, run, authenticatedActor) =>
      run(
        ["update", args.id, "--claim"],
        effectiveActor(args, authenticatedActor),
      ),
  );

  register(
    "release",
    "Release your own claim and return the task to open. Optionally append a reason first.",
    Schema.Struct({
      id,
      actor: optionalActor,
      reason: opt(text("Reason for releasing")),
      expected_revision: expectedRevision,
    }),
    false,
    async (args, run, authenticatedActor) => {
      const writer = effectiveActor(args, authenticatedActor);
      await assertOwner(run, args.id, writer, args.expected_revision);
      if (args.reason)
        await run(["comments", "add", args.id, "--", args.reason], writer);
      return run(["update", args.id, "--assignee=", "--status=open"], writer);
    },
  );

  register(
    "add_note",
    "Append findings, decisions, blockers, or evidence URLs to a task's comments.",
    Schema.Struct({
      id,
      actor: optionalActor,
      note: text("Comment body; include artifact URLs when relevant"),
    }),
    false,
    (args, run, authenticatedActor) =>
      run(
        ["comments", "add", args.id, "--", args.note],
        effectiveActor(args, authenticatedActor),
      ),
    true,
  );

  register(
    "link",
    "Add or remove a relationship. With blocks, id depends on target (target must finish first). Beads checks cycles.",
    Schema.Struct({
      id,
      target: id,
      actor: optionalActor,
      action: Schema.Literal("add", "remove"),
      type: opt(
        Schema.Literal(
          "blocks",
          "parent-child",
          "related",
          "discovered-from",
          "relates-to",
          "supersedes",
        ),
      ),
    }),
    false,
    (args, run, authenticatedActor) => {
      const writer = effectiveActor(args, authenticatedActor);
      if (args.action === "remove" && args.type)
        throw new Error("Remove identifies the edge by its two IDs; omit type");
      return run(
        [
          "dep",
          args.action,
          args.id,
          args.target,
          ...(args.action === "add" ? [`--type=${args.type ?? "blocks"}`] : []),
        ],
        writer,
      );
    },
  );

  register(
    "complete",
    "Close a task with a result summary and evidence. Does not force unresolved dependencies or gates. Fails with OWNERSHIP_CONFLICT if another actor holds the claim.",
    Schema.Struct({
      id,
      actor: optionalActor,
      summary: text("Result summary, including evidence or artifact URLs"),
      expected_revision: expectedRevision,
    }),
    false,
    async (args, run, authenticatedActor) => {
      const writer = effectiveActor(args, authenticatedActor);
      const issue = await readIssue(run, args.id, writer);
      assertRevision(issue, args.expected_revision);
      assertNotClaimedByOther(issue, writer);
      return run(["close", args.id, `--reason=${args.summary}`], writer);
    },
  );

  register(
    "handoff",
    "Append a structured handoff to your claimed task; optionally release it. Note and release are sequential, not a database transaction. If release fails, the note remains.",
    Schema.Struct({
      id,
      actor: optionalActor,
      done: text("Work completed"),
      remaining: text("Work still needed"),
      next: text("Next concrete action"),
      release: opt(
        Schema.Boolean.annotations({
          description: "Release claim after recording handoff; default false",
        }),
      ),
      expected_revision: expectedRevision,
    }),
    false,
    async (args, run, authenticatedActor) => {
      const writer = effectiveActor(args, authenticatedActor);
      await assertOwner(run, args.id, writer, args.expected_revision);
      const note = await run(
        [
          "comments",
          "add",
          args.id,
          "--",
          JSON.stringify({
            kind: "handoff",
            actor: writer,
            done: args.done,
            remaining: args.remaining,
            next: args.next,
          }),
        ],
        writer,
      );
      if (!args.release) return { note };
      try {
        return {
          note,
          task: await run(
            ["update", args.id, "--assignee=", "--status=open"],
            writer,
          ),
        };
      } catch {
        return {
          note,
          released: false,
          warning:
            "Handoff recorded but release failed; inspect the task before retrying.",
        };
      }
    },
  );
}
