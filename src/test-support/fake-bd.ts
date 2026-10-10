import type { BeadsCommand } from "../beads.ts";
import { classifyFailure } from "../errors.ts";

interface FakeComment {
  id: string;
  author: string;
  text: string;
  created_at: string;
}

interface FakeIssue {
  id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  priority: number;
  status: string;
  issue_type: string;
  assignee?: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  comments: FakeComment[];
  blockedBy: Set<string>;
  claimedAt?: string;
}

/**
 * Stateful in-memory stand-in for the `bd` CLI.
 *
 * It reproduces the behaviors observed against the deployed server that the
 * MCP layer has to work around:
 * - notes and label changes do NOT advance `updated_at`
 * - claims emit `lease_expires_at` / `heartbeat_at` that nothing enforces
 * - a claim by a different actor fails; re-claiming your own task is a no-op
 *
 * Failures go through the real `classifyFailure`, so error codes seen in
 * tests are the ones production would produce for the same stderr text.
 */
export function createFakeBd() {
  const issues = new Map<string, FakeIssue>();
  let seq = 0;
  let clock = Date.parse("2026-10-10T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const commands: string[][] = [];

  function view(issue: FakeIssue, includeComments: boolean) {
    return {
      id: issue.id,
      title: issue.title,
      ...(issue.description !== undefined
        ? { description: issue.description }
        : {}),
      ...(issue.acceptance_criteria !== undefined
        ? { acceptance_criteria: issue.acceptance_criteria }
        : {}),
      status: issue.status,
      priority: issue.priority,
      issue_type: issue.issue_type,
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      ...(issue.claimedAt
        ? {
            lease_expires_at: issue.claimedAt,
            heartbeat_at: issue.claimedAt,
          }
        : {}),
      labels: [...issue.labels].sort(),
      dependency_count: issue.blockedBy.size,
      dependent_count: [...issues.values()].filter((other) =>
        other.blockedBy.has(issue.id),
      ).length,
      comment_count: issue.comments.length,
      ...(includeComments
        ? { comments: issue.comments.map((c) => ({ ...c })) }
        : {}),
    };
  }

  function mustGet(id: string, write: boolean): FakeIssue {
    const issue = issues.get(id);
    if (!issue)
      throw classifyFailure({
        stderr: "Error: issue not found",
        code: 1,
        write,
      });
    return issue;
  }

  function dependsOn(
    from: string,
    target: string,
    seen = new Set<string>(),
  ): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(issues.get(from)?.blockedBy ?? [])].some((next) =>
      dependsOn(next, target, seen),
    );
  }

  const run: BeadsCommand = async (args, actor = "mcp") => {
    commands.push(args);
    // Yield to the event loop so that, absent the queue, calls would interleave.
    await new Promise((resolve) => setImmediate(resolve));
    const [command, ...rest] = args;

    if (command === "create") {
      const issue: FakeIssue = {
        id: `task-${(++seq).toString(36).padStart(3, "0")}`,
        title: "",
        priority: 2,
        status: "open",
        issue_type: "task",
        labels: [],
        created_at: tick(),
        updated_at: "",
        comments: [],
        blockedBy: new Set(),
      };
      issue.updated_at = issue.created_at;
      for (const arg of rest) {
        const [, key, value] = /^--([a-z-]+)=(.*)$/s.exec(arg) ?? [];
        if (key === "title") issue.title = value;
        if (key === "description") issue.description = value;
        if (key === "acceptance") issue.acceptance_criteria = value;
        if (key === "priority") issue.priority = Number(value);
        if (key === "type") issue.issue_type = value;
        if (key === "labels") issue.labels = value.split(",").filter(Boolean);
      }
      issues.set(issue.id, issue);
      return view(issue, false);
    }

    if (command === "show") {
      const issue = mustGet(rest[0], false);
      return [view(issue, rest.includes("--include-comments"))];
    }

    if (command === "update") {
      const issue = mustGet(rest[0], true);
      let touchesRow = false;
      for (const arg of rest.slice(1)) {
        if (arg === "--claim") {
          if (issue.assignee && issue.assignee !== actor)
            throw classifyFailure({
              stderr: `already claimed by ${issue.assignee}`,
              code: 1,
              write: true,
            });
          if (!issue.assignee) {
            issue.assignee = actor;
            issue.status = "in_progress";
            issue.claimedAt = tick();
            touchesRow = true;
          }
          continue;
        }
        const [, key, value] = /^--([a-z-]+)=(.*)$/s.exec(arg) ?? [];
        if (key === "title") {
          issue.title = value;
          touchesRow = true;
        }
        if (key === "description") {
          issue.description = value;
          touchesRow = true;
        }
        if (key === "acceptance") {
          issue.acceptance_criteria = value;
          touchesRow = true;
        }
        if (key === "priority") {
          issue.priority = Number(value);
          touchesRow = true;
        }
        if (key === "status") {
          issue.status = value;
          touchesRow = true;
        }
        if (key === "assignee") {
          issue.assignee = value || undefined;
          if (!value) issue.claimedAt = undefined;
          touchesRow = true;
        }
        // Labels deliberately leave updated_at alone, as observed.
        if (key === "add-label")
          for (const label of value.split(",")) {
            if (label && !issue.labels.includes(label))
              issue.labels.push(label);
          }
        if (key === "remove-label")
          issue.labels = issue.labels.filter(
            (label) => !value.split(",").includes(label),
          );
      }
      if (touchesRow) issue.updated_at = tick();
      return [view(issue, false)];
    }

    if (command === "comments" && rest[0] === "add") {
      const issue = mustGet(rest[1], true);
      const comment: FakeComment = {
        id: `c-${issue.id}-${issue.comments.length + 1}`,
        author: actor,
        text: rest.at(-1) ?? "",
        created_at: tick(),
      };
      // Notes deliberately leave updated_at alone, as observed.
      issue.comments.push(comment);
      return comment;
    }

    if (command === "close") {
      const issue = mustGet(rest[0], true);
      issue.status = "closed";
      issue.updated_at = tick();
      return [view(issue, false)];
    }

    if (command === "dep") {
      const [action, id, target] = rest;
      const issue = mustGet(id, true);
      mustGet(target, true);
      if (action === "add") {
        if (dependsOn(target, id))
          throw classifyFailure({
            stderr: "adding this dependency would create a cycle",
            code: 1,
            write: true,
          });
        issue.blockedBy.add(target);
      } else {
        issue.blockedBy.delete(target);
      }
      return { status: action === "add" ? "added" : "removed" };
    }

    return [];
  };

  return {
    run,
    commands,
    /** Direct, queue-bypassing read of persisted state for assertions. */
    peek(id: string) {
      const issue = issues.get(id);
      return issue ? view(issue, true) : undefined;
    },
  };
}
