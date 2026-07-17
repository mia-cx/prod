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

export class InvalidModelConfigurationError extends Error {
  override readonly name = "InvalidModelConfigurationError";
}

export class ModelCredentialError extends Error {
  override readonly name = "ModelCredentialError";

  public constructor() {
    super("The stored guild model credential could not be decrypted");
  }
}
