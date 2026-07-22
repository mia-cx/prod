export type ModelPurpose = "triage";
export type ModelProvider = "openrouter";

export type GuildModelConfiguration = Readonly<{
  guildId: string;
  purpose: ModelPurpose;
  provider: ModelProvider;
  modelId: string;
  guildApiKeyHint?: string;
}>;

export type SetModelInput = Readonly<{
  guildId: string;
  purpose: ModelPurpose;
  provider: ModelProvider;
  modelId: string;
}>;

export type SetGuildApiKeyInput = Readonly<{
  guildId: string;
  purpose: ModelPurpose;
  apiKey: string;
}>;

export type ModelConfigurationStore = Readonly<{
  get(guildId: string, purpose: ModelPurpose): Promise<GuildModelConfiguration>;
  setModel(input: SetModelInput): Promise<void>;
  setGuildApiKey(input: SetGuildApiKeyInput): Promise<void>;
  clearGuildApiKey(guildId: string, purpose: ModelPurpose): Promise<void>;
}>;

export type ResolvedModelConfiguration = Readonly<{
  available: true;
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  credentialSource: "guild" | "deployment";
}>;

export type UnavailableModelConfiguration = Readonly<{
  available: false;
  provider: ModelProvider;
  modelId: string;
  reason: "missing-credential";
}>;

export interface SecureModelConfigurationStore
  extends ModelConfigurationStore {
  resolve(
    guildId: string,
    purpose: ModelPurpose,
    deploymentApiKey?: string,
  ): Promise<ResolvedModelConfiguration | UnavailableModelConfiguration>;
}

const MODEL_IDENTIFIER_PATTERN = /^[\w.:-]+(?:\/[\w.:-]+)*$/u;
const MODEL_IDENTIFIER_MAX_LENGTH = 200;

export const isValidModelIdentifier = (value: string): boolean =>
  value.length <= MODEL_IDENTIFIER_MAX_LENGTH &&
  MODEL_IDENTIFIER_PATTERN.test(value);

export class InvalidModelConfigurationError extends Error {
  override readonly name = "InvalidModelConfigurationError";
}

export class ModelCredentialError extends Error {
  override readonly name = "ModelCredentialError";

  public constructor() {
    super("The stored guild model credential could not be decrypted");
  }
}
