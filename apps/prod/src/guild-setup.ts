import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";

import type {
  GuildSettingsStore,
  GuildSetupSettings,
} from "./guild-settings.js";
import type { HubTransition } from "./hub-transition.js";
import type { SupportHubDiscord, SupportHubValidation } from "./support-hub.js";

export interface GuildSetupService {
  get(guild: Guild): Promise<GuildSetupSettings>;
  validateHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  configureHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  refreshInformationMessage(guild: Guild): Promise<SupportHubValidation>;
  setAssistantIdentity(guild: Guild, identity: string): Promise<void>;
  setTone(guild: Guild, tone: string): Promise<void>;
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

  const compensate = async (
    guild: Guild,
    transition: HubTransition,
    assistantIdentity: string,
  ): Promise<unknown[]> => {
    const errors: unknown[] = [];
    await discord
      .releaseHub(guild, transition.next)
      .catch((error: unknown) => errors.push(error));
    const previous = transition.previous;
    if (previous.hubPermissionOwnership !== undefined) {
      await discord
        .restoreHub(guild, previous.hubPermissionOwnership)
        .catch((error: unknown) => errors.push(error));
    }
    if (
      previous.hubChannelId !== undefined &&
      previous.hubInformationMessageId !== undefined
    ) {
      await discord
        .upsertInformationMessage({
          guild,
          channelId: previous.hubChannelId,
          assistantIdentity,
          messageId: previous.hubInformationMessageId,
        })
        .then((messageId) =>
          store.setHubInformationMessage(guild.id, messageId),
        )
        .catch((error: unknown) => errors.push(error));
    }
    if (errors.length === 0) {
      await store
        .abortHubTransition(guild.id, transition.id)
        .catch((error: unknown) => errors.push(error));
    }
    return errors;
  };

  const resumeTransition = async (
    guild: Guild,
    transition: HubTransition,
    assistantIdentity: string,
  ): Promise<SupportHubValidation> => {
    let configured;
    try {
      configured = await discord.applyHub(guild, transition.next);
    } catch (error) {
      return throwTransitionFailure(
        error,
        await compensate(guild, transition, assistantIdentity),
      );
    }
    if (!configured.valid) {
      const errors = await compensate(guild, transition, assistantIdentity);
      if (errors.length > 0) {
        throw new AggregateError(
          [new Error(configured.issues.join(" ")), ...errors],
          "Invalid support hub could not be fully compensated",
        );
      }
      return configured;
    }

    try {
      const previous = transition.previous;
      if (
        previous.hubChannelId !== undefined &&
        previous.hubPermissionOwnership !== undefined
      ) {
        if (previous.hubInformationMessageId !== undefined) {
          await discord.deleteInformationMessage(
            guild,
            previous.hubChannelId,
            previous.hubInformationMessageId,
          );
        }
        await discord.releaseHub(guild, previous.hubPermissionOwnership);
      }
      await store.completeHubTransition(guild.id, transition);
      return { valid: true as const };
    } catch (error) {
      return throwTransitionFailure(
        error,
        await compensate(guild, transition, assistantIdentity),
      );
    }
  };

  const recoverPendingTransition = async (guild: Guild): Promise<void> => {
    const transition = await store.getHubTransition(guild.id);
    if (transition === undefined) return;
    const state = await store.get(guild.id);
    await resumeTransition(guild, transition, state.assistantIdentity);
  };

  return Object.freeze({
    get: (guild: Guild) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        return store.get(guild.id);
      }),
    validateHub: (guild: Guild, channelId: string) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        return discord.validateHub(guild, channelId);
      }),
    configureHub: (guild: Guild, channelId: string) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        const previous = await store.get(guild.id);
        const sameHub = previous.hubChannelId === channelId;
        const prepared = await discord.prepareHub(
          guild,
          channelId,
          sameHub ? previous.hubPermissionOwnership : undefined,
        );
        if (!prepared.valid) return prepared;

        if (sameHub) {
          const applied = await discord.applyHub(
            guild,
            prepared.permissionOwnership,
          );
          if (!applied.valid) {
            if (previous.hubPermissionOwnership !== undefined) {
              await discord.restoreHub(guild, previous.hubPermissionOwnership);
            }
            return applied;
          }
          await store.configureHub(
            guild.id,
            channelId,
            prepared.permissionOwnership,
          );
          return { valid: true as const };
        }

        const transition: HubTransition = Object.freeze({
          version: 1,
          id: randomUUID(),
          previous: Object.freeze({
            ...(previous.hubChannelId === undefined
              ? {}
              : { hubChannelId: previous.hubChannelId }),
            ...(previous.hubInformationMessageId === undefined
              ? {}
              : {
                  hubInformationMessageId: previous.hubInformationMessageId,
                }),
            ...(previous.hubPermissionOwnership === undefined
              ? {}
              : {
                  hubPermissionOwnership: previous.hubPermissionOwnership,
                }),
          }),
          next: prepared.permissionOwnership,
        });
        await store.beginHubTransition(guild.id, transition);
        return resumeTransition(guild, transition, previous.assistantIdentity);
      }),
    refreshInformationMessage: (guild: Guild) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
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
        const configured = await discord.applyHub(
          guild,
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
    setAssistantIdentity: (guild: Guild, identity: string) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        await store.setAssistantIdentity(guild.id, identity);
      }),
    setTone: (guild: Guild, tone: string) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        await store.setTone(guild.id, tone);
      }),
  });
};
