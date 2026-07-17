import { Schema } from "effect";
import { decodeEncryptionKey } from "@mia-cx/protocord-model-settings";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const NoWhitespaceString = NonEmptyString.pipe(
  Schema.pattern(/^\S+$/),
);
const ModelIdentifier = NoWhitespaceString.pipe(
  Schema.filter((value) => !value.includes("://") && value.length <= 200, {
    message: () => "must be a model identifier, not a URL",
  }),
);
const DiscordSnowflake = Schema.String.pipe(Schema.pattern(/^\d{17,20}$/));
const DatabaseUrl = Schema.String.pipe(
  Schema.filter((value) => value === ":memory:" || value.startsWith("file:"), {
    message: () => "must be :memory: or a file: URL",
  }),
);
const LogLevel = Schema.Literal(
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
);

export type LogLevel = typeof LogLevel.Type;

export type ProdConfig = Readonly<{
  discordToken: string;
  discordClientId: string;
  botOperatorUserIds: readonly string[];
  textCommandPrefix: string;
  databaseUrl: string;
  logLevel: LogLevel;
  openRouterApiKey?: string;
  apiKeyEncryptionKey: string;
  defaultTriageModel: string;
  openRouterBaseUrl: string;
}>;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

type Environment = Readonly<Record<string, string | undefined>>;

const decodeRequired = <A, I>(
  environment: Environment,
  key: string,
  schema: Schema.Schema<A, I>,
): A => {
  const value = environment[key];
  if (value === undefined) {
    throw new ConfigurationError(`${key} is required`);
  }

  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new ConfigurationError(`${key} is invalid`);
  }
};

const decodeOptional = <A, I>(
  environment: Environment,
  key: string,
  schema: Schema.Schema<A, I>,
  fallback: A,
): A => {
  const value = environment[key];
  if (value === undefined) {
    return fallback;
  }

  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new ConfigurationError(`${key} is invalid`);
  }
};

const decodeBotOperatorUserIds = (
  environment: Environment,
): readonly string[] => {
  const value = environment.BOT_OPERATOR_USER_IDS;
  if (value === undefined || value.trim().length === 0) {
    return Object.freeze([]);
  }

  try {
    const userIds = value
      .split(",")
      .map((userId) => userId.trim())
      .map((userId) => Schema.decodeUnknownSync(DiscordSnowflake)(userId));
    return Object.freeze([...new Set(userIds)].sort());
  } catch {
    throw new ConfigurationError("BOT_OPERATOR_USER_IDS is invalid");
  }
};

const decodeEncryptionKeyConfig = (environment: Environment): string => {
  const value = decodeRequired(
    environment,
    "API_KEY_ENCRYPTION_KEY",
    NonEmptyString,
  );
  try {
    decodeEncryptionKey(value);
    return value;
  } catch {
    throw new ConfigurationError("API_KEY_ENCRYPTION_KEY is invalid");
  }
};

const decodeOpenRouterBaseUrl = (environment: Environment): string => {
  const value = decodeOptional(
    environment,
    "OPENROUTER_BASE_URL",
    NonEmptyString,
    "https://openrouter.ai/api/v1/",
  );
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new TypeError();
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  } catch {
    throw new ConfigurationError("OPENROUTER_BASE_URL is invalid");
  }
};

export const loadConfig = (environment: Environment): ProdConfig =>
  Object.freeze({
    discordToken: decodeRequired(environment, "DISCORD_TOKEN", NonEmptyString),
    discordClientId: decodeRequired(
      environment,
      "DISCORD_CLIENT_ID",
      DiscordSnowflake,
    ),
    botOperatorUserIds: decodeBotOperatorUserIds(environment),
    textCommandPrefix: decodeOptional(
      environment,
      "TEXT_COMMAND_PREFIX",
      Schema.String,
      "",
    ),
    databaseUrl: decodeOptional(
      environment,
      "DATABASE_URL",
      DatabaseUrl,
      "file:./data/prod.sqlite",
    ),
    logLevel: decodeOptional(environment, "LOG_LEVEL", LogLevel, "info"),
    ...(environment.OPENROUTER_API_KEY === undefined ||
    environment.OPENROUTER_API_KEY.length === 0
      ? {}
      : {
          openRouterApiKey: decodeRequired(
            environment,
            "OPENROUTER_API_KEY",
            NoWhitespaceString,
          ),
        }),
    apiKeyEncryptionKey: decodeEncryptionKeyConfig(environment),
    defaultTriageModel: decodeOptional(
      environment,
      "DEFAULT_TRIAGE_MODEL",
      ModelIdentifier,
      "google/gemma-4-31b-it",
    ),
    openRouterBaseUrl: decodeOpenRouterBaseUrl(environment),
  });
