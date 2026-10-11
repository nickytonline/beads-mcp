import { Effect, LogLevel, Logger, References } from "effect";
import { getConfig } from "./config.ts";

type LogFields = Readonly<Record<string, unknown>>;
type LogInput = LogFields | string;

const minimumLevel = {
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
} satisfies Record<ConfigLogLevel, LogLevel.Severity>;

type ConfigLogLevel = "error" | "warn" | "info" | "debug";

const jsonLoggers: ReadonlySet<Logger.Logger<unknown, unknown>> = new Set([
  Logger.consoleJson,
]);

function log(
  level: LogLevel.Severity,
  fieldsOrMessage: LogInput,
  message?: string,
) {
  const config = getConfig();
  const fields = typeof fieldsOrMessage === "string" ? {} : fieldsOrMessage;
  const text =
    typeof fieldsOrMessage === "string" ? fieldsOrMessage : (message ?? "");

  return Effect.logWithLevel(level)(text).pipe(
    Effect.annotateLogs({
      service: config.SERVER_NAME,
      version: config.SERVER_VERSION,
      environment: config.NODE_ENV,
      ...fields,
    }),
    Effect.provideService(
      References.MinimumLogLevel,
      minimumLevel[config.LOG_LEVEL],
    ),
    Effect.provideService(Logger.CurrentLoggers, jsonLoggers),
  );
}

/** Structured Effect logging used by the server and tool workflows. */
export const logger = {
  debug: (fieldsOrMessage: LogInput, message?: string) =>
    log("Debug", fieldsOrMessage, message),
  info: (fieldsOrMessage: LogInput, message?: string) =>
    log("Info", fieldsOrMessage, message),
  warn: (fieldsOrMessage: LogInput, message?: string) =>
    log("Warn", fieldsOrMessage, message),
  error: (fieldsOrMessage: LogInput, message?: string) =>
    log("Error", fieldsOrMessage, message),
};
