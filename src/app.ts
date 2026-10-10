import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Effect } from "effect";
import { logger } from "./logger.ts";
import { getConfig } from "./config.ts";
import { registerTools } from "./tools.ts";
import { runMcpEffect } from "./lib/utils.ts";

const getServer = () => {
  const config = getConfig();
  const server = new McpServer({
    name: config.SERVER_NAME,
    version: config.SERVER_VERSION,
  });

  registerTools(server);

  return server;
};

/** Creates the Express app and MCP handler used by the production entrypoint. */
export function createApp(options: { token?: string } = {}) {
  const token = options.token ?? process.env.MCP_TOKEN;
  if (getConfig().NODE_ENV === "production" && !token) {
    throw new Error("MCP_TOKEN is required in production");
  }
  // createMcpHandler runs the factory fresh per request (2026-07-28 spec: no
  // initialize/initialized handshake, no Mcp-Session-Id). It also answers
  // 2025-era clients automatically via a stateless per-request fallback.
  const handler = createMcpHandler(getServer, {
    onerror: (error) => {
      void runMcpEffect(
        logger.error({ error: error.message }, "Error handling MCP request"),
      );
    },
  });

  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => {
      void runMcpEffect(
        logger.error(
          { error: error.message },
          "Error adapting MCP request for Node",
        ),
      );
    },
  });

  const app = express();
  app.use("/mcp", (req, res, next) => {
    if (token) {
      const hash = (value: string) =>
        createHash("sha256").update(value).digest();
      if (
        !timingSafeEqual(
          hash(req.headers.authorization ?? ""),
          hash(`Bearer ${token}`),
        )
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", (req, res) => {
    void runMcpEffect(
      Effect.tryPromise({
        try: () => nodeHandler(req, res, req.body),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* logger.error(
              { error: error instanceof Error ? error.message : String(error) },
              "Unhandled error serving MCP request",
            );
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
              });
            } else {
              res.end();
            }
          }),
        ),
      ),
    );
  });

  return { app, handler };
}
