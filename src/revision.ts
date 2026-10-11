import { createHash } from "node:crypto";

export type Issue = Record<string, unknown>;

/**
 * Change-detection contract
 *
 * `bd`'s own `updated_at` and `revision` do not advance for notes or label
 * changes, so they cannot be trusted for change detection. The MCP layer
 * therefore computes its own tokens from task content:
 *
 * - `state_revision`: covers every field an `update` can change (title,
 *   description, acceptance criteria, priority, status, assignee, type,
 *   labels). This is the compare-and-swap token for `expected_revision`.
 *   Notes and dependency edges do NOT change it, so adding a note never
 *   causes a false edit conflict.
 * - `activity_revision`: covers `state_revision` plus notes and dependency
 *   counts. Poll this to learn whether anything at all changed.
 * - `last_activity_at`: newest of `updated_at` and any note timestamp.
 */
const STATE_FIELDS = [
  "title",
  "description",
  "acceptance_criteria",
  "priority",
  "status",
  "assignee",
  "issue_type",
] as const;

const REVISION_PREFIX = "s1-";
export const REVISION_PATTERN = /^s1-[0-9a-f]{16}$/u;

function digest(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

function labelsOf(issue: Issue): string[] {
  return Array.isArray(issue.labels) ? issue.labels.map(String).sort() : [];
}

function commentsOf(issue: Issue): Issue[] {
  return Array.isArray(issue.comments) ? (issue.comments as Issue[]) : [];
}

export function stateRevision(issue: Issue): string {
  return (
    REVISION_PREFIX +
    digest([
      ...STATE_FIELDS.map((field) => issue[field] ?? null),
      labelsOf(issue),
    ])
  );
}

export function activityRevision(issue: Issue): string {
  const comments = commentsOf(issue);
  const count =
    typeof issue.comment_count === "number"
      ? issue.comment_count
      : comments.length;
  const lastComment = comments.at(-1);
  return (
    "a1-" +
    digest([
      stateRevision(issue),
      count,
      lastComment?.id ?? null,
      issue.dependency_count ?? 0,
      issue.dependent_count ?? 0,
    ])
  );
}

export function lastActivityAt(issue: Issue): string | null {
  const stamps = [
    issue.updated_at,
    ...commentsOf(issue).map((comment) => comment.created_at),
  ].filter((value): value is string => typeof value === "string");
  let newest: string | null = null;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    const time = Date.parse(stamp);
    if (!Number.isNaN(time) && time > newestTime) {
      newest = stamp;
      newestTime = time;
    }
  }
  return newest;
}

export function withRevisions(issue: Issue): Issue {
  return {
    ...issue,
    state_revision: stateRevision(issue),
    activity_revision: activityRevision(issue),
    last_activity_at: lastActivityAt(issue),
  };
}

/**
 * Claims never expire in this server. `bd` emits lease fields on claim, but
 * nothing here enforces or renews them, so they are removed rather than left
 * to suggest an ownership guarantee that does not exist.
 */
const LEASE_FIELDS = new Set(["lease_expires_at", "heartbeat_at"]);

export function stripLeaseMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLeaseMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !LEASE_FIELDS.has(key))
        .map(([key, inner]) => [key, stripLeaseMetadata(inner)]),
    );
  }
  return value;
}
