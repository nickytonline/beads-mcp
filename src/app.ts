import express from "express";
import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Effect } from "effect";
import { logger } from "./logger.ts";
import { getConfig } from "./config.ts";
import { registerTools } from "./tools.ts";
import { getSkillsInstructions, registerSkills } from "./skills.ts";
import { runMcpEffect } from "./lib/utils.ts";
import {
  createJwtKeySet,
  JwksRetrievalError,
  verifyJwtIdentity,
  type AuthenticatedIdentity,
} from "./auth.ts";

const getServer = (actor: string) => {
  const config = getConfig();
  const server = new McpServer(
    {
      name: config.SERVER_NAME,
      version: config.SERVER_VERSION,
    },
    { instructions: getSkillsInstructions() },
  );

  registerTools(server, undefined, actor);
  registerSkills(server);

  return server;
};

/** Creates the Express app and MCP handler used by the production entrypoint. */
export function createApp(
  options: {
    jwtVerifier?: (token: string) => Promise<AuthenticatedIdentity>;
  } = {},
) {
  const config = getConfig();
  if (!config.AUTH_JWKS_URL || !config.AUTH_ISSUER || !config.AUTH_AUDIENCE) {
    throw new Error(
      "AUTH_JWKS_URL, AUTH_ISSUER, and AUTH_AUDIENCE must be configured",
    );
  }
  const jwtKeySet = createJwtKeySet(config.AUTH_JWKS_URL);
  const jwtVerifier =
    options.jwtVerifier ??
    ((token: string) => verifyJwtIdentity(token, config, jwtKeySet));
  // createMcpHandler runs the factory fresh per request (2026-07-28 spec: no
  // initialize/initialized handshake, no Mcp-Session-Id). It also answers
  // 2025-era clients automatically via a stateless per-request fallback.
  const handler = createMcpHandler(
    (ctx) => {
      const actor = ctx.authInfo?.extra?.actor;
      if (typeof actor !== "string") {
        throw new Error("Authenticated actor missing from request context");
      }
      return getServer(actor);
    },
    {
      onerror: (error) => {
        void runMcpEffect(
          logger.error({ error: error.message }, "Error handling MCP request"),
        );
      },
    },
  );

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
  app.use("/mcp", async (req, res, next) => {
    const headerValue = req.get(config.AUTH_JWT_HEADER)?.trim();
    const token = headerValue?.replace(/^Bearer\s+/i, "");
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const identity = await jwtVerifier(token);
      const auth: AuthInfo = {
        token,
        clientId: identity.actor,
        scopes: [],
        expiresAt: identity.expiresAt,
        extra: { actor: identity.actor },
      };
      (req as typeof req & { auth: AuthInfo }).auth = auth;
      next();
    } catch (error) {
      void runMcpEffect(
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "JWT verification failed for /mcp request",
        ),
      );
      if (error instanceof JwksRetrievalError) {
        res.status(503).json({ error: "Authentication service unavailable" });
      } else {
        res.status(401).json({ error: "Unauthorized" });
      }
    }
  });
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", (req, res) => {
    void runMcpEffect(
      Effect.tryPromise({
        try: () =>
          nodeHandler(req as typeof req & { auth: AuthInfo }, res, req.body),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
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
