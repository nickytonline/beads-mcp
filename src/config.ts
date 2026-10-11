import { Config as EffectConfig, ConfigProvider, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };

const configEffect = EffectConfig.all({
  PORT: EffectConfig.Number("PORT").pipe(EffectConfig.withDefault(3000)),
  NODE_ENV: EffectConfig.Literals(
    ["development", "production", "test"],
    "NODE_ENV",
  ).pipe(EffectConfig.withDefault("development")),
  SERVER_NAME: EffectConfig.String("SERVER_NAME").pipe(
    EffectConfig.withDefault(packageJson.name),
  ),
  SERVER_VERSION: EffectConfig.String("SERVER_VERSION").pipe(
    EffectConfig.withDefault(packageJson.version),
  ),
  LOG_LEVEL: EffectConfig.Literals(
    ["error", "warn", "info", "debug"],
    "LOG_LEVEL",
  ).pipe(EffectConfig.withDefault("info")),
  AUTH_JWT_HEADER: EffectConfig.String("AUTH_JWT_HEADER").pipe(
    EffectConfig.withDefault("X-Authenticated-JWT"),
  ),
  AUTH_JWKS_URL: EffectConfig.String("AUTH_JWKS_URL").pipe(
    EffectConfig.withDefault(""),
  ),
  AUTH_ISSUER: EffectConfig.String("AUTH_ISSUER").pipe(
    EffectConfig.withDefault(""),
  ),
  AUTH_AUDIENCE: EffectConfig.String("AUTH_AUDIENCE").pipe(
    EffectConfig.withDefault(""),
  ),
  AUTH_ACTOR_CLAIM: EffectConfig.String("AUTH_ACTOR_CLAIM").pipe(
    EffectConfig.withDefault("email"),
  ),
});

export type Config =
  typeof configEffect extends EffectConfig.Config<infer ConfigValue>
    ? ConfigValue
    : never;

const loadConfig = configEffect.parse(ConfigProvider.fromEnv());

let config: Config | undefined;

function failInvalidConfig(error: unknown): never {
  process.stderr.write(`Invalid environment configuration: ${String(error)}\n`);
  process.exit(1);
}

export function getConfig(): Config {
  if (!config) {
    try {
      config = Effect.runSync(loadConfig);
    } catch (error) {
      return failInvalidConfig(error);
    }
  }
  return config;
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === "production";
}

export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === "development";
}
