import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { logger } from "./logger.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLines(run: () => Promise<void>) {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return run().then(() => lines.map((line) => JSON.parse(line)));
}

describe("logger", () => {
  it("writes one JSON line per entry with a stable field contract", async () => {
    const [entry] = await captureLines(() =>
      Effect.runPromise(
        logger.warn({ requestId: 7, toolName: "get" }, "Tool executed"),
      ),
    );

    expect(Object.keys(entry)).toEqual([
      "message",
      "logLevel",
      "timestamp",
      "annotations",
      "spans",
      "fiberId",
    ]);
    expect(entry).toMatchObject({
      message: "Tool executed",
      logLevel: "WARN",
      annotations: { requestId: 7, toolName: "get" },
    });
  });

  it("drops entries below the configured minimum level", async () => {
    const lines = await captureLines(() =>
      Effect.runPromise(logger.debug("hidden at the default info level")),
    );

    expect(lines).toEqual([]);
  });
});
