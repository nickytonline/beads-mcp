import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type JwtKeySet = JWTVerifyGetKey | Uint8Array;

export type JwtAuthConfig = {
  AUTH_JWT_HEADER: string;
  AUTH_JWKS_URL: string;
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  AUTH_ACTOR_CLAIM: string;
};

export type AuthenticatedIdentity = {
  actor: string;
  expiresAt: number;
  payload: JWTPayload;
};

/** The JWKS provider failed before a verification key could be resolved. */
export class JwksRetrievalError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "JWKS key retrieval failed",
      {
        cause,
      },
    );
    this.name = "JwksRetrievalError";
  }
}

const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._@+|:-]*$/;

/** Normalize an identity before it is used as a Beads actor. */
export function normalizeActor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !ACTOR_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function actorFromPayload(
  payload: JWTPayload,
  actorClaim: string,
): string {
  const actor =
    normalizeActor(payload[actorClaim]) ?? normalizeActor(payload.sub);
  if (!actor) {
    throw new Error("JWT does not contain a valid actor identity");
  }
  return actor;
}

export function createJwtKeySet(url: string): JwtKeySet {
  const keySet = createRemoteJWKSet(new URL(url));
  return async (header, token) => {
    try {
      return await keySet(header, token);
    } catch (error) {
      // Key selection can fail because of the token's kid or alg even when
      // the provider returned a valid JWKS. These remain authentication errors.
      if (
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys ||
        error instanceof errors.JOSENotSupported
      ) {
        throw error;
      }
      // Classify at the resolver boundary: jose also uses generic JOSEError
      // and native fetch/import errors for provider failures. Token parsing,
      // signature verification, and claim validation happen outside it.
      throw new JwksRetrievalError(error);
    }
  };
}

export async function verifyJwtIdentity(
  token: string,
  config: JwtAuthConfig,
  keySet: JwtKeySet = createJwtKeySet(config.AUTH_JWKS_URL),
): Promise<AuthenticatedIdentity> {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    requiredClaims: ["exp"],
  });
  const actor = actorFromPayload(payload, config.AUTH_ACTOR_CLAIM);
  return { actor, expiresAt: payload.exp as number, payload };
}
