import type { DestinationStream, Logger } from "pino";
import pino from "pino";

import type { LogLevel } from "./config.js";

const REDACTED = "[Redacted]";

const secretPaths = [
  "token",
  "discordToken",
  "DISCORD_TOKEN",
  "openRouterApiKey",
  "OPENROUTER_API_KEY",
  "apiKeyEncryptionKey",
  "API_KEY_ENCRYPTION_KEY",
  "*.token",
  "*.discordToken",
  "*.DISCORD_TOKEN",
  "*.openRouterApiKey",
  "*.OPENROUTER_API_KEY",
  "*.apiKeyEncryptionKey",
  "*.API_KEY_ENCRYPTION_KEY",
] as const;

export type LoggerConfig = Readonly<{
  level: LogLevel;
  secrets?: readonly string[];
}>;

const redactText = (value: string, secrets: readonly string[]): string =>
  secrets.reduce(
    (redacted, secret) => (secret.length === 0 ? redacted : redacted.replaceAll(secret, REDACTED)),
    value,
  );

const serializeError = (value: unknown, secrets: readonly string[]): Record<string, unknown> => {
  if (!(value instanceof Error)) {
    return { message: redactText(String(value), secrets) };
  }

  return {
    type: value.name,
    message: redactText(value.message, secrets),
    stack: value.stack === undefined ? undefined : redactText(value.stack, secrets),
  };
};

export const createLogger = (
  config: LoggerConfig,
  destination?: DestinationStream,
): Logger => {
  const options = {
    name: "prod",
    level: config.level,
    redact: {
      paths: [...secretPaths],
      censor: REDACTED,
    },
    serializers: {
      err: (value: unknown) => serializeError(value, config.secrets ?? []),
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
};

