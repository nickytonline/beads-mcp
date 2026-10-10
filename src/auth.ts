import {
  createRemoteJWKSet,
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

const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._@-]*$/;

/** Normalize an identity before it is used as a Beads actor. */
export function normalizeActor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
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
  return createRemoteJWKSet(new URL(url));
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
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("JWT is expired");
  }
  return { actor, expiresAt: payload.exp, payload };
}
