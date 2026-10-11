/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeExecuteBeadsHttp, parseBdServeTimeout } from "./beads-http.ts";
import { stateRevision, withRevisions } from "./revision.ts";
import {
  createFakeBdServe,
  type FakeBdServe,
} from "./test-support/fake-bd-serve.ts";
import type { BeadsCommand } from "./beads.ts";

describe("executeBeadsHttp", () => {
  let fake: FakeBdServe;
  let run: BeadsCommand;
  // `run` returns Promise<unknown> like the real BeadsCommand contract; tests
  // read arbitrary fields off the result the same way hardening.test.ts's
  // `Out.body: any` does, rather than asserting a shape with `as`.
  let call: (args: string[], actor?: string) => Promise<any>;

  beforeEach(async () => {
    fake = await createFakeBdServe();
    run = makeExecuteBeadsHttp(fake.url, { timeoutMs: 1_000 });
    call = run;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fake.close();
  });

  it("create: translates flags into a POST body and returns the issue", async () => {
    const issue = await call(
      ["create", "--title=Fix bug", "--priority=1", "--labels=a,b"],
      "alice",
    );
    expect(issue.title).toBe("Fix bug");
    expect(issue.priority).toBe(1);
    expect(issue.labels).toEqual(["a", "b"]);
  });

  it("show: returns a bare object (not array-wrapped) with full fields", async () => {
    const created = await call(
      ["create", "--title=T", "--description=D"],
      "alice",
    );
    const issue = await call(["show", created.id]);
    expect(Array.isArray(issue)).toBe(false);
    expect(issue.id).toBe(created.id);
    expect(issue.description).toBe("D");
  });

  it("show --include-comments: embeds comments", async () => {
    const created = await call(["create", "--title=T"], "alice");
    await call(["comments", "add", created.id, "--", "a note"], "alice");
    const issue = await call(["show", created.id, "--include-comments"]);
    expect(issue.comments).toHaveLength(1);
  });

  it("show: feeds cleanly into revision.ts (regression guard for field-name drift)", async () => {
    const created = await call(
      ["create", "--title=T", "--description=D"],
      "alice",
    );
    const issue = await call(["show", created.id]);
    const withRev = withRevisions(issue);
    expect(withRev.state_revision).toBe(stateRevision(issue));
    expect(typeof withRev.state_revision).toBe("string");
  });

  it("ready: unwraps items from the list envelope", async () => {
    await call(["create", "--title=T1"], "alice");
    await call(["create", "--title=T2"], "alice");
    const result = await call(["ready", "--limit=20"]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("search: builds a title query clause and unwraps items", async () => {
    await call(["create", "--title=Fix the login flow"], "alice");
    await call(["create", "--title=Unrelated"], "alice");
    const result = await call(["search", "--query=login flow", "--limit=20"]);
    expect(result).toHaveLength(1);
  });

  it("update: maps edit flags to a PATCH patch object", async () => {
    const created = await call(["create", "--title=T"], "alice");
    const updated = await call(
      ["update", created.id, "--title=New title", "--priority=0"],
      "alice",
    );
    expect(updated.title).toBe("New title");
    expect(updated.priority).toBe(0);
  });

  it("update --add-label/--remove-label: merges with existing labels via an extra GET", async () => {
    const created = await call(
      ["create", "--title=T", "--labels=keep,drop"],
      "alice",
    );
    const updated = await call(
      ["update", created.id, "--add-label=new", "--remove-label=drop"],
      "alice",
    );
    expect(new Set(updated.labels)).toEqual(new Set(["keep", "new"]));
  });

  it("update --claim: routes to the :claim action", async () => {
    const created = await call(["create", "--title=T"], "alice");
    const claimed = await call(["update", created.id, "--claim"], "alice");
    expect(claimed.status).toBe("in_progress");
    expect(claimed.assignee).toBe("alice");
  });

  it("claim conflict: a different actor gets OWNERSHIP_CONFLICT", async () => {
    const created = await call(["create", "--title=T"], "alice");
    await call(["update", created.id, "--claim"], "alice");
    await expect(
      call(["update", created.id, "--claim"], "bob"),
    ).rejects.toMatchObject({
      code: "OWNERSHIP_CONFLICT",
    });
  });

  it("release-shape update (--assignee= --status=open): routes to :release", async () => {
    const created = await call(["create", "--title=T"], "alice");
    await call(["update", created.id, "--claim"], "alice");
    const released = await call(
      ["update", created.id, "--assignee=", "--status=open"],
      "alice",
    );
    expect(released.status).toBe("open");
    expect(released.assignee).toBeUndefined();
  });

  it("comments add: posts to the issue's comments route", async () => {
    const created = await call(["create", "--title=T"], "alice");
    const comment = await call(
      ["comments", "add", created.id, "--", "hello"],
      "alice",
    );
    expect(comment.text).toBe("hello");
    expect(comment.author).toBe("alice");
  });

  it("dep add/remove: round-trips a dependency edge", async () => {
    const a = await call(["create", "--title=A"], "alice");
    const b = await call(["create", "--title=B"], "alice");
    await call(["dep", "add", a.id, b.id, "--type=blocks"], "alice");
    await call(["dep", "remove", a.id, b.id], "alice");
  });

  it("dep add: a cycle is rejected with DEPENDENCY_CYCLE", async () => {
    const a = await call(["create", "--title=A"], "alice");
    const b = await call(["create", "--title=B"], "alice");
    await call(["dep", "add", a.id, b.id, "--type=blocks"], "alice");
    await expect(
      call(["dep", "add", b.id, a.id, "--type=blocks"], "alice"),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
  });

  it("close: routes to the :close action", async () => {
    const created = await call(["create", "--title=T"], "alice");
    const closed = await call(["close", created.id, "--reason=done"], "alice");
    expect(closed.status).toBe("closed");
  });

  it("404: maps to NOT_FOUND", async () => {
    await expect(call(["show", "no-such-id"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("connection refused: maps to BACKEND_UNAVAILABLE", async () => {
    await fake.close();
    await expect(call(["show", "whatever"])).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    });
  });

  it("network failure after dispatch preserves uncertain write outcomes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("connection reset")),
    );
    await expect(run(["create", "--title=T"])).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: false,
      outcomeUnknown: true,
    });
    await expect(run(["show", "task-id"])).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
      outcomeUnknown: false,
    });
  });

  it.each(["TypeError", "AbortError", "TimeoutError"])(
    "classifies %s while reading a response body",
    async (name) => {
      const response = new Response("{}", { status: 200 });
      const error = new Error("body read failed");
      error.name = name;
      vi.spyOn(response, "text").mockRejectedValue(error);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(run(["create", "--title=T"])).rejects.toMatchObject({
        code:
          name === "TypeError" ? "BACKEND_UNAVAILABLE" : "OUTCOME_UNCERTAIN",
        retryable: false,
        outcomeUnknown: true,
      });
      await expect(run(["show", "task-id"])).rejects.toMatchObject({
        retryable: true,
        outcomeUnknown: false,
      });
    },
  );

  it("timeout: maps to OUTCOME_UNCERTAIN for a write, retryable for a read", async () => {
    fake.hangNext("GET", "/v0/beads/issues/");
    await expect(call(["show", "whatever"])).rejects.toMatchObject({
      code: "OUTCOME_UNCERTAIN",
      retryable: true, // read
    });

    fake.hangNext("POST", "/v0/beads/issues");
    await expect(call(["create", "--title=T"], "alice")).rejects.toMatchObject({
      code: "OUTCOME_UNCERTAIN",
      retryable: false, // write
      outcomeUnknown: true,
    });
  });

  it("malformed 2xx body: fails safe as OUTCOME_UNCERTAIN, never crashes", async () => {
    fake.failNextRaw("GET", "/v0/beads/issues/", 200, "{invalid-json");
    await expect(run(["show", "whatever"])).rejects.toMatchObject({
      code: "OUTCOME_UNCERTAIN",
      retryable: true,
      outcomeUnknown: false,
    });
    fake.failNextRaw("POST", "/v0/beads/issues", 200, "{invalid-json");
    await expect(run(["create", "--title=T"])).rejects.toMatchObject({
      code: "OUTCOME_UNCERTAIN",
      retryable: false,
      outcomeUnknown: true,
    });
  });

  it("unsupported subcommand: fails INTERNAL rather than silently no-op", async () => {
    await expect(call(["list"])).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("BD_SERVE_TIMEOUT_MS", () => {
  it("defaults when unset and accepts positive integer milliseconds", () => {
    expect(parseBdServeTimeout(undefined)).toBeUndefined();
    expect(parseBdServeTimeout("30000")).toBe(30_000);
  });
  it.each(["", "abc", "NaN", "Infinity", "0", "-1", "1.5", "4294967296"])(
    "rejects invalid timeout %s before dispatch",
    (value) => {
      expect(() => parseBdServeTimeout(value)).toThrow("BD_SERVE_TIMEOUT_MS");
    },
  );
  it.each([NaN, Infinity, 0, -1, 1.5, 4294967296])(
    "rejects invalid factory timeout %s",
    (timeoutMs) => {
      expect(() =>
        makeExecuteBeadsHttp("http://localhost", { timeoutMs }),
      ).toThrow();
    },
  );
});
