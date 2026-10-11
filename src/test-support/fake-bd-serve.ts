import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Minimal in-memory stand-in for `bd serve`'s HTTP API, used to test
 * `src/beads-http.ts`'s argv-to-route translation without a real Dolt
 * server. Mirrors the exact shapes confirmed against a live `bd serve` +
 * `dolt sql-server` in `--server` mode (see the implementation plan), not a
 * guess at the contract.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface FakeIssue {
  id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  status: string;
  priority: number;
  issue_type: string;
  owner: string;
  assignee?: string;
  labels?: string[];
  created_at: string;
  updated_at: string;
  comments?: FakeComment[];
  comment_count: number;
  dependency_count: number;
  dependent_count: number;
}

interface FakeComment {
  id: string;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export interface FakeBdServe {
  url: string;
  issues: Map<string, FakeIssue>;
  close(): Promise<void>;
  /** The next matching request fails with this status/body instead of running normally. */
  failNext(
    method: string,
    pathPrefix: string,
    status: number,
    body: unknown,
  ): void;
  /** Return literal response text, including invalid JSON. */
  failNextRaw(
    method: string,
    pathPrefix: string,
    status: number,
    body: string,
  ): void;
  /** The next matching request never responds (for timeout tests). */
  hangNext(method: string, pathPrefix: string): void;
}

export function createFakeBdServe(): Promise<FakeBdServe> {
  const issues = new Map<string, FakeIssue>();
  const dependencies = new Set<string>(); // `${issueId}->${dependsOnId}`
  const pendingFailures: Array<{
    method: string;
    pathPrefix: string;
    status: number;
    body: unknown;
    raw?: boolean;
  }> = [];
  const pendingHangs: Array<{ method: string; pathPrefix: string }> = [];

  function createsCycle(issueId: string, dependsOnId: string): boolean {
    // Would `issueId depends on dependsOnId` create a cycle, i.e. does
    // dependsOnId already (transitively) depend on issueId?
    const stack = [dependsOnId];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      if (current === issueId) return true;
      seen.add(current);
      for (const edge of dependencies) {
        const [from, to] = edge.split("->");
        if (from === current) stack.push(to);
      }
    }
    return false;
  }

  function sendJson(
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }

  function takeFailure(method: string, pathname: string) {
    const index = pendingFailures.findIndex(
      (entry) =>
        entry.method === method && pathname.startsWith(entry.pathPrefix),
    );
    if (index === -1) return undefined;
    return pendingFailures.splice(index, 1)[0];
  }

  function takeHang(method: string, pathname: string) {
    const index = pendingHangs.findIndex(
      (entry) =>
        entry.method === method && pathname.startsWith(entry.pathPrefix),
    );
    if (index === -1) return false;
    pendingHangs.splice(index, 1);
    return true;
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (takeHang(method, pathname)) return; // never respond

      const failure = takeFailure(method, pathname);
      if (failure) {
        if (failure.raw) {
          res.writeHead(failure.status, { "Content-Type": "application/json" });
          res.end(String(failure.body));
          return;
        }
        sendJson(res, failure.status, failure.body);
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;

      try {
        handle(method, pathname, url.searchParams, body, res);
      } catch (error) {
        sendJson(res, 500, {
          code: "internal",
          detail: String(error),
          status: 500,
        });
      }
    });
  });

  function handle(
    method: string,
    pathname: string,
    params: URLSearchParams,
    body: Record<string, unknown> | undefined,
    res: import("node:http").ServerResponse,
  ) {
    if (method === "GET" && pathname === "/v0/beads/context") {
      sendJson(res, 200, {
        api_version: "v0",
        backend: "dolt",
        bd_version: "1.3.1",
        dolt_mode: "server",
        schema_version: 1,
      });
      return;
    }

    if (method === "GET" && pathname === "/v0/beads/ready") {
      const items = [...issues.values()].filter(
        (issue) => issue.status !== "closed",
      );
      sendJson(res, 200, { items, has_more: false });
      return;
    }

    if (method === "GET" && pathname === "/v0/beads/issues:query") {
      const q = params.get("q") ?? "";
      const includeClosed = params.get("all") === "true";
      const titleMatch = /title="?([^"]*)"?/.exec(q)?.[1]?.toLowerCase() ?? "";
      const items = [...issues.values()].filter(
        (issue) =>
          (includeClosed || issue.status !== "closed") &&
          issue.title.toLowerCase().includes(titleMatch),
      );
      sendJson(res, 200, { items, has_more: false });
      return;
    }

    if (method === "POST" && pathname === "/v0/beads/issues") {
      // Real bd serve has no server-side default for issue_type and rejects
      // an empty one outright -- the CLI defaults it, bd serve does not.
      if (!body?.issue_type) {
        sendJson(res, 400, {
          code: "invalid_argument",
          detail: 'validation failed for issue : invalid issue type: ""',
          status: 400,
        });
        return;
      }
      const now = new Date().toISOString();
      const issue: FakeIssue = {
        id: `fake-${randomUUID().slice(0, 8)}`,
        title: String(body?.title ?? ""),
        description:
          typeof body?.description === "string" ? body.description : undefined,
        acceptance_criteria:
          typeof body?.acceptance_criteria === "string"
            ? body.acceptance_criteria
            : undefined,
        status: "open",
        priority: typeof body?.priority === "number" ? body.priority : 2,
        issue_type: String(body.issue_type),
        owner: String(body?.actor ?? "mcp"),
        labels: Array.isArray(body?.labels) ? body.labels.map(String) : [],
        created_at: now,
        updated_at: now,
        comment_count: 0,
        dependency_count: 0,
        dependent_count: 0,
      };
      issues.set(issue.id, issue);
      sendJson(res, 200, issue);
      return;
    }

    const issueMatch = /^\/v0\/beads\/issues\/([^/:]+)(.*)$/.exec(pathname);
    if (issueMatch) {
      const [, id, suffix] = issueMatch;
      const issue = issues.get(id);

      if (!issue && suffix !== "/comments") {
        sendJson(res, 404, {
          code: "not_found",
          detail: "no issue or wisp with that id",
          status: 404,
        });
        return;
      }

      if (method === "GET" && suffix === "") {
        const includeComments = params.get("include_comments") === "true";
        const { comments, ...rest } = issue!;
        sendJson(
          res,
          200,
          includeComments ? { ...rest, comments: comments ?? [] } : rest,
        );
        return;
      }

      if (method === "PATCH" && suffix === "") {
        const patch = isRecord(body?.patch) ? body.patch : {};
        Object.assign(issue!, patch);
        issue!.updated_at = new Date().toISOString();
        sendJson(res, 200, {
          changed: true,
          issue,
          revision: String(Date.now()),
        });
        return;
      }

      if (method === "POST" && suffix === ":claim") {
        if (issue!.assignee && issue!.assignee !== body?.actor) {
          sendJson(res, 409, {
            code: "already_claimed",
            detail: "issue is claimed by another actor",
            assignee: issue!.assignee,
            status: 409,
          });
          return;
        }
        issue!.assignee = String(body?.actor);
        issue!.status = "in_progress";
        sendJson(res, 200, { already_claimed: false, issue });
        return;
      }

      if (method === "POST" && suffix === ":release") {
        delete issue!.assignee;
        issue!.status = "open";
        sendJson(res, 200, {
          changed: true,
          issue,
          revision: String(Date.now()),
        });
        return;
      }

      if (method === "POST" && suffix === ":close") {
        issue!.status = "closed";
        sendJson(res, 200, { already_closed: false, issue, open_children: 0 });
        return;
      }

      if (method === "POST" && suffix === "/comments") {
        const comment: FakeComment = {
          id: randomUUID(),
          issue_id: id,
          author: String(body?.author ?? "mcp"),
          text: String(body?.text ?? ""),
          created_at: new Date().toISOString(),
        };
        if (issue) {
          issue.comments = [...(issue.comments ?? []), comment];
          issue.comment_count = issue.comments.length;
        }
        sendJson(res, 200, comment);
        return;
      }
    }

    if (method === "POST" && pathname === "/v0/beads/dependencies:add") {
      const rawEdges = Array.isArray(body?.edges) ? body.edges : [];
      const edges = rawEdges.filter(isRecord).map((edge) => ({
        issue_id: String(edge.issue_id),
        depends_on_id: String(edge.depends_on_id),
        type: String(edge.type ?? "blocks"),
      }));
      for (const edge of edges) {
        if (createsCycle(edge.issue_id, edge.depends_on_id)) {
          sendJson(res, 409, {
            code: "dependency_cycle",
            detail:
              "the requested edges would create a dependency cycle; nothing was written",
            status: 409,
          });
          return;
        }
      }
      for (const edge of edges)
        dependencies.add(`${edge.issue_id}->${edge.depends_on_id}`);
      sendJson(res, 200, { added: edges });
      return;
    }

    if (method === "POST" && pathname === "/v0/beads/dependencies:remove") {
      dependencies.delete(`${body?.issue_id}->${body?.depends_on_id}`);
      sendJson(res, 200, { removed: true });
      return;
    }

    sendJson(res, 404, {
      code: "not_found",
      detail: "no such route on this server",
      status: 404,
    });
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        issues,
        failNext(method, pathPrefix, status, body) {
          pendingFailures.push({ method, pathPrefix, status, body });
        },
        failNextRaw(method, pathPrefix, status, body) {
          pendingFailures.push({ method, pathPrefix, status, body, raw: true });
        },
        hangNext(method, pathPrefix) {
          pendingHangs.push({ method, pathPrefix });
        },
        close() {
          return new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          );
        },
      });
    });
  });
}

export type { Server };
