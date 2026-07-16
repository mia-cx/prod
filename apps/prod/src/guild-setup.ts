import type { Guild } from "discord.js";

import type {
  GuildSettingsStore,
  GuildSetupSettings,
} from "./guild-settings.js";
import type { SupportHubDiscord, SupportHubValidation } from "./support-hub.js";

export interface GuildSetupService {
  get(guildId: string): Promise<GuildSetupSettings>;
  validateHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  configureHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  refreshInformationMessage(guild: Guild): Promise<SupportHubValidation>;
  setAssistantIdentity(guildId: string, identity: string): Promise<void>;
  setTone(guildId: string, tone: string): Promise<void>;
}

const createKeyedExecutor = () => {
  const tails = new Map<string, Promise<void>>();
  return async <Value>(
    key: string,
    task: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
};

const throwTransitionFailure = (
  error: unknown,
  compensationErrors: readonly unknown[],
): never => {
  if (compensationErrors.length === 0) throw error;
  throw new AggregateError(
    [error, ...compensationErrors],
    "Support hub transition failed and could not be fully compensated",
  );
};

export const createGuildSetupService = (
  store: GuildSettingsStore,
  discord: SupportHubDiscord,
): GuildSetupService => {
  const execute = createKeyedExecutor();

  return Object.freeze({
    get: (guildId: string) => store.get(guildId),
    validateHub: (guild: Guild, channelId: string) =>
      discord.validateHub(guild, channelId),
    configureHub: (guild: Guild, channelId: string) =>
      execute(guild.id, async () => {
        const previous = await store.get(guild.id);
        const sameHub = previous.hubChannelId === channelId;
        const configured = await discord.configureHub(
          guild,
          channelId,
          sameHub ? previous.hubPermissionOwnership : undefined,
        );
        if (!configured.valid) return configured;

        if (sameHub) {
          await store.configureHub(
            guild.id,
            channelId,
            configured.permissionOwnership,
          );
          return { valid: true as const };
        }

        try {
          if (previous.hubChannelId !== undefined) {
            if (previous.hubPermissionOwnership === undefined) {
              throw new Error(
                "Configured support hub is missing permission ownership",
              );
            }
            if (previous.hubInformationMessageId !== undefined) {
              await discord.deleteInformationMessage(
                guild,
                previous.hubChannelId,
                previous.hubInformationMessageId,
              );
            }
            await discord.releaseHub(guild, previous.hubPermissionOwnership);
          }
          await store.configureHub(
            guild.id,
            channelId,
            configured.permissionOwnership,
          );
          return { valid: true as const };
        } catch (error) {
          const compensationErrors: unknown[] = [];
          await discord
            .releaseHub(guild, configured.permissionOwnership)
            .catch((compensationError: unknown) => {
              compensationErrors.push(compensationError);
            });
          if (previous.hubPermissionOwnership !== undefined) {
            await discord
              .restoreHub(guild, previous.hubPermissionOwnership)
              .catch((compensationError: unknown) => {
                compensationErrors.push(compensationError);
              });
          }
          return throwTransitionFailure(error, compensationErrors);
        }
      }),
    refreshInformationMessage: (guild: Guild) =>
      execute(guild.id, async () => {
        const state = await store.get(guild.id);
        if (
          state.hubChannelId === undefined ||
          state.hubPermissionOwnership === undefined
        ) {
          return {
            valid: false as const,
            issues: ["Configure a support hub before posting information."],
          };
        }
        const configured = await discord.configureHub(
          guild,
          state.hubChannelId,
          state.hubPermissionOwnership,
        );
        if (!configured.valid) return configured;
        const messageId = await discord.upsertInformationMessage({
          guild,
          channelId: state.hubChannelId,
          assistantIdentity: state.assistantIdentity,
          ...(state.hubInformationMessageId === undefined
            ? {}
            : { messageId: state.hubInformationMessageId }),
        });
        await store.setHubInformationMessage(guild.id, messageId);
        return { valid: true as const };
      }),
    setAssistantIdentity: (guildId: string, identity: string) =>
      execute(guildId, () => store.setAssistantIdentity(guildId, identity)),
    setTone: (guildId: string, tone: string) =>
      execute(guildId, () => store.setTone(guildId, tone)),
  });
};
