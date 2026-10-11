import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { getSkillsInstructions, registerSkills, SKILL_URI } from "./skills.ts";

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

let handler: ReturnType<typeof createMcpHandler> | undefined;

beforeEach(() => {
  handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { instructions: getSkillsInstructions() },
    );
    registerSkills(server);
    return server;
  });
});

afterEach(async () => {
  await handler?.close();
  handler = undefined;
});

async function request(
  method: string,
  params: Record<string, unknown> = {},
): Promise<JsonRpcResponse> {
  if (!handler) throw new Error("test handler is not initialized");

  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
        ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "skills-test",
              version: "0.0.0",
            },
          },
        },
      }),
    }),
  );

  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`Missing SSE data in ${body}`);
    return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

describe("Beads engineering skill extension", () => {
  it("advertises the extension and instructions through server/discover", async () => {
    const response = await request("server/discover");
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      capabilities: {
        resources: {},
        extensions: { "io.modelcontextprotocol/skills": {} },
      },
    });
    expect(response.result?.instructions).toContain(SKILL_URI);
  });

  it("lists a complete manifest, gets it by URI, and reads the skill resource", async () => {
    const listResponse = await request("skills/list");
    const listResult = listResponse.result as {
      resultType: string;
      skills: Array<{
        uri: string;
        frontmatter: { name: string; description: string };
        resources: Array<{ uri: string; digest: string; size: number }>;
      }>;
      ttlMs: number;
      cacheScope: string;
    };

    expect(listResult.resultType).toBe("complete");
    expect(listResult.ttlMs).toBe(300_000);
    expect(listResult.cacheScope).toBe("public");
    expect(listResult.skills).toHaveLength(1);

    const skill = listResult.skills[0];
    expect(skill.uri).toBe(SKILL_URI);
    expect(skill.frontmatter.name).toBe("beads-engineering-backlog");
    expect(skill.frontmatter.description).toContain(
      "persistent engineering backlog",
    );
    expect(skill.resources).toHaveLength(1);
    expect(skill.resources[0]).toMatchObject({ uri: SKILL_URI });

    const getResponse = await request("skills/get", { uri: SKILL_URI });
    expect(getResponse.result).toMatchObject({
      resultType: "complete",
      skill,
      ttlMs: 300_000,
      cacheScope: "public",
    });

    const readResponse = await request("resources/read", { uri: SKILL_URI });
    const contents = (
      readResponse.result?.contents as Array<{
        text: string;
      }>
    )[0];
    const bytes = Buffer.from(contents.text, "utf8");
    expect(contents.text).toContain("# Beads engineering backlog");
    expect(skill.resources[0].size).toBe(bytes.byteLength);
    expect(skill.resources[0].digest).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });

  it("returns invalid params for an unknown skill URI", async () => {
    const response = await request("skills/get", {
      uri: "skill://missing/SKILL.md",
    });
    expect(response.error?.code).toBe(-32602);
  });
});
