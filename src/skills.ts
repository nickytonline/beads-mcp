import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { toMcpSchema } from "./lib/mcp-schema.ts";

export const SKILL_URI = "skill://beads-engineering-backlog/SKILL.md" as const;
const SKILL_DIRECTORY_NAME = "beads-engineering-backlog";
const CACHE_TTL_MS = 300_000;

type SkillResource = {
  uri: string;
  digest: string;
  size: number;
};

type SkillFrontmatter = {
  name: string;
  description: string;
  [key: string]: unknown;
};

type SkillEntry = {
  uri: string;
  frontmatter: SkillFrontmatter;
  resources: SkillResource[];
};

type SkillFile = {
  relativePath: string;
  uri: string;
  bytes: Buffer;
  text: string;
  mimeType: string;
};

type SkillCatalog = {
  entry: SkillEntry;
  files: Map<string, SkillFile>;
};

const skillRoot = fileURLToPath(
  new URL("../skills/beads-engineering-backlog/", import.meta.url),
);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrontmatter(document: string): SkillFrontmatter {
  if (!document.startsWith("---\n")) {
    throw new Error("Skill SKILL.md must start with YAML frontmatter");
  }

  const closingMarker = document.indexOf("\n---\n", 4);
  if (closingMarker < 0) {
    throw new Error("Skill SKILL.md has no closing YAML frontmatter marker");
  }

  const parsed = parseYaml(document.slice(4, closingMarker));
  if (!isMapping(parsed)) {
    throw new Error("Skill frontmatter must be a YAML mapping");
  }

  const { name, description } = parsed;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 1024
  ) {
    throw new Error(
      "Skill frontmatter must include a name and a 1-1024 character description",
    );
  }

  return { ...parsed, name, description };
}

function mimeTypeFor(relativePath: string): string {
  if (relativePath.endsWith(".md")) return "text/markdown";
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function collectSkillFiles(
  directory: string,
  prefix = "",
  files: SkillFile[] = [],
): SkillFile[] {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSkillFiles(path, relativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;

    const bytes = readFileSync(path);
    files.push({
      relativePath,
      uri: `skill://${SKILL_DIRECTORY_NAME}/${relativePath}`,
      bytes,
      text: bytes.toString("utf8"),
      mimeType: mimeTypeFor(relativePath),
    });
  }
  return files;
}

function loadSkillCatalog(): SkillCatalog {
  const files = collectSkillFiles(skillRoot);
  const skillFile = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillFile) throw new Error("Skill directory must contain SKILL.md");

  const frontmatter = parseFrontmatter(skillFile.text);
  if (frontmatter.name !== SKILL_DIRECTORY_NAME) {
    throw new Error(
      `Skill name ${String(frontmatter.name)} must match its directory name`,
    );
  }

  const resources = files
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => ({
      uri: file.uri,
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
      size: file.bytes.byteLength,
    }));

  return {
    entry: { uri: SKILL_URI, frontmatter, resources },
    files: new Map(files.map((file) => [file.uri, file])),
  };
}

const catalog = loadSkillCatalog();
const listSkillsParams = toMcpSchema(
  Schema.Struct({ cursor: Schema.optional(Schema.String) }),
);
const getSkillParams = toMcpSchema(Schema.Struct({ uri: Schema.String }));

function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function readResource(file: SkillFile, uri: URL) {
  if (file.mimeType === "application/octet-stream") {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: file.mimeType,
          blob: file.bytes.toString("base64"),
        },
      ],
    };
  }
  return {
    contents: [{ uri: uri.href, mimeType: file.mimeType, text: file.text }],
  };
}

/**
 * The server instructions are a discovery fallback for clients that do not
 * implement the Skills extension. Reading the URI is not activation; the host
 * decides whether to verify, approve, and load a skill.
 */
export function getSkillsInstructions(): string {
  return `Optional agent guidance is available at ${SKILL_URI}. Clients that support the MCP Skills extension can confirm it with skills/get and read it with resources/read. Reading the resource does not automatically activate it; the host remains responsible for trust, approval, and integrity checks.`;
}

/**
 * Registers the canonical engineering-backlog skill and the stable Skills
 * extension methods. Directory reads are intentionally not advertised.
 */
export function registerSkills(server: McpServer): void {
  server.server.registerCapabilities({
    resources: {},
    extensions: { "io.modelcontextprotocol/skills": {} },
  });

  for (const file of catalog.files.values()) {
    server.registerResource(
      file.relativePath === "SKILL.md"
        ? catalog.entry.frontmatter.name
        : basename(file.relativePath),
      file.uri,
      {
        description:
          file.relativePath === "SKILL.md"
            ? catalog.entry.frontmatter.description
            : undefined,
        mimeType: file.mimeType,
        cacheHint: { ttlMs: CACHE_TTL_MS, cacheScope: "public" },
      },
      async (uri: URL, _ctx: ServerContext) => readResource(file, uri),
    );
  }

  server.server.setRequestHandler(
    "skills/list",
    { params: listSkillsParams },
    async ({ cursor }: { cursor?: string }) => {
      if (cursor !== undefined) {
        throw invalidParams("Unknown skills/list cursor");
      }
      return {
        resultType: "complete",
        skills: [catalog.entry],
        ttlMs: CACHE_TTL_MS,
        cacheScope: "public",
      };
    },
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: getSkillParams },
    async ({ uri }: { uri: string }) => {
      if (uri !== catalog.entry.uri) {
        throw invalidParams(`Unknown skill URI: ${uri}`);
      }
      return {
        resultType: "complete",
        skill: catalog.entry,
        ttlMs: CACHE_TTL_MS,
        cacheScope: "public",
      };
    },
  );
}
