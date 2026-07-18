import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";

import type {
  GuildSettingsStore,
  GuildSetupSettings,
} from "./guild-settings.js";
import type { HubTransition } from "./hub-transition.js";
import {
  createGuildOperationExecutor,
  type ExecuteGuildOperation,
} from "./guild-operation.js";
import type { SupportHubDiscord, SupportHubValidation } from "./support-hub.js";

export interface GuildSetupService {
  get(guild: Guild): Promise<GuildSetupSettings>;
  validateHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  configureHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  refreshInformationMessage(guild: Guild): Promise<SupportHubValidation>;
  setAssistantIdentity(guild: Guild, identity: string): Promise<void>;
  setSystemPrompt(guild: Guild, prompt: string): Promise<void>;
  setTone(guild: Guild, tone: string): Promise<void>;
}

export interface ReporterHubAccessSuspender {
  suspendHubAccess(guild: Guild, hubChannelId: string): Promise<number>;
  canReleaseHub(guildId: string, hubChannelId: string): Promise<boolean>;
}

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
  reporterAccess: ReporterHubAccessSuspender,
  executeGuildOperation: ExecuteGuildOperation = createGuildOperationExecutor(),
): GuildSetupService => {
  const execute = executeGuildOperation;

  const compensate = async (
    guild: Guild,
    transition: HubTransition,
  ): Promise<unknown[]> => {
    const errors: unknown[] = [];
    await discord
      .releaseHub(guild, transition.next)
      .catch((error: unknown) => errors.push(error));
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
  ): Promise<SupportHubValidation> => {
    if (transition.phase === "prepared") {
      let configured;
      try {
        configured = await discord.applyHub(guild, transition.next);
      } catch (error) {
        return throwTransitionFailure(
          error,
          await compensate(guild, transition),
        );
      }
      if (!configured.valid) {
        const errors = await compensate(guild, transition);
        if (errors.length > 0) {
          throw new AggregateError(
            [new Error(configured.issues.join(" ")), ...errors],
            "Invalid support hub could not be fully compensated",
          );
        }
        return configured;
      }
      try {
        await store.promoteHubTransition(guild.id, transition);
      } catch (error) {
        return throwTransitionFailure(
          error,
          await compensate(guild, transition),
        );
      }
    }

    const previous = transition.previous;
    if (
      previous.hubChannelId !== undefined &&
      previous.hubPermissionOwnership !== undefined
    ) {
      await reporterAccess.suspendHubAccess(guild, previous.hubChannelId);
      await discord.deleteInformationMessage(
        guild,
        previous.hubChannelId,
        previous.hubInformationMessageId,
      );
      await discord.releaseFormerHub(guild, previous.hubPermissionOwnership);
    }
    await store.finishHubTransition(guild.id, transition.id);
    return { valid: true as const };
  };

  const recoverPendingTransition = async (guild: Guild): Promise<void> => {
    const transition = await store.getHubTransition(guild.id);
    if (transition === undefined) return;
    await resumeTransition(guild, transition);
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
        if (
          !sameHub &&
          previous.hubChannelId !== undefined &&
          !(await reporterAccess.canReleaseHub(
            guild.id,
            previous.hubChannelId,
          ))
        ) {
          return {
            valid: false as const,
            issues: [
              "The support hub cannot be changed while tickets remain active.",
            ],
          };
        }
        const prepared = await discord.prepareHub(
          guild,
          channelId,
          sameHub ? previous.hubPermissionOwnership : undefined,
        );
        if (!prepared.valid) return prepared;

        if (sameHub) {
          let applied;
          try {
            applied = await discord.applyHub(
              guild,
              prepared.permissionOwnership,
            );
          } catch (error) {
            try {
              await discord.restoreHub(guild, prepared.permissionOwnership);
            } catch (restoreError) {
              throw new AggregateError(
                [error, restoreError],
                "Support hub reapplication failed and the locked state could not be reasserted",
              );
            }
            throw error;
          }
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
          phase: "prepared",
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
        return resumeTransition(guild, transition);
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
    setSystemPrompt: (guild: Guild, prompt: string) =>
      execute(guild.id, async () => {
        await recoverPendingTransition(guild);
        await store.setSystemPrompt(guild.id, prompt);
      }),
  });
};
