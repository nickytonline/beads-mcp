import { describe, it, expect } from "vitest";
import { BeadsClient } from "./beads.ts";

describe("embedded Beads queue", () => {
  it("serializes compound jobs and recovers after failure", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const order: string[] = [];
    const client = new BeadsClient(async ([name]) => {
      order.push(name);
      if (name === "first") await gate;
      return null;
    });
    const first = client.transaction(async (run) => {
      await run(["first"]);
      await run(["second"]);
    });
    const failing = client.transaction(async () => {
      throw new Error("failed");
    });
    const failure = expect(failing).rejects.toThrow("failed");
    const last = client.transaction((run) => run(["last"]));
    await Promise.resolve();
    expect(order).toEqual(["first"]);
    unblock();
    await Promise.all([first, failure, last]);
    expect(order).toEqual(["first", "second", "last"]);
    await client.drain();
    await expect(client.transaction(async () => null)).rejects.toThrow(
      "shutting down",
    );
  });
});
