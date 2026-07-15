import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
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
  textCommandPrefix: string;
  databaseUrl: string;
  logLevel: LogLevel;
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

export const loadConfig = (environment: Environment): ProdConfig =>
  Object.freeze({
    discordToken: decodeRequired(environment, "DISCORD_TOKEN", NonEmptyString),
    discordClientId: decodeRequired(
      environment,
      "DISCORD_CLIENT_ID",
      DiscordSnowflake,
    ),
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
  });
