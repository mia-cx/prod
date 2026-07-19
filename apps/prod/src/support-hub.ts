import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type GuildMember,
  type Message,
  type PermissionOverwriteOptions,
  type PermissionResolvable,
  type TextChannel,
} from "discord.js";

import {
  HUB_BOT_PERMISSION_NAMES,
  HUB_PROTECTED_PERMISSION_NAMES,
  type HubPermissionOwnership,
  type HubPermissionOwnershipV2,
  type HubPermissionState,
  type HubProtectedPermissionName,
} from "./hub-permission-ownership.js";

export const EMPTY_HUB_REPORTER_OVERWRITE = Object.freeze({
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  ManageThreads: false,
} as const);

export const SUPPORT_HUB_BOT_OVERWRITE = Object.freeze({
  SendMessages: true,
  SendMessagesInThreads: true,
  CreatePrivateThreads: true,
  ManageThreads: true,
} as const);

export const SUPPORT_HUB_INFORMATION_MARKER =
  "-# Managed by Prod · support-hub-information:v1";

const protectedPermissionBits = Object.freeze({
  SendMessages: PermissionFlagsBits.SendMessages,
  SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
  CreatePublicThreads: PermissionFlagsBits.CreatePublicThreads,
  CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
  ManageThreads: PermissionFlagsBits.ManageThreads,
} satisfies Readonly<Record<HubProtectedPermissionName, bigint>>);

const requiredBotPermissions = Object.freeze([
  ["View Channel", PermissionFlagsBits.ViewChannel],
  [
    "Manage Roles (channel permission overwrites)",
    PermissionFlagsBits.ManageRoles,
  ],
  ["Create Private Threads", PermissionFlagsBits.CreatePrivateThreads],
  ["Manage Threads", PermissionFlagsBits.ManageThreads],
  ["Send Messages", PermissionFlagsBits.SendMessages],
  ["Send Messages in Threads", PermissionFlagsBits.SendMessagesInThreads],
  ["Read Message History", PermissionFlagsBits.ReadMessageHistory],
  ["Use Application Commands", PermissionFlagsBits.UseApplicationCommands],
  ["Embed Links", PermissionFlagsBits.EmbedLinks],
] as const satisfies readonly (readonly [string, PermissionResolvable])[]);

export const REQUIRED_HUB_BOT_PERMISSION_NAMES = Object.freeze(
  requiredBotPermissions.map(([name]) => name),
);

export type SupportHubValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; issues: readonly string[] }>;

export type ConfigureSupportHubResult =
  | Readonly<{ valid: true; permissionOwnership: HubPermissionOwnership }>
  | Readonly<{ valid: false; issues: readonly string[] }>;

export type UpsertHubInformationInput = Readonly<{
  guild: Guild;
  channelId: string;
  assistantIdentity: string;
  messageId?: string;
}>;

export interface SupportHubDiscord {
  validateHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  prepareHub(
    guild: Guild,
    channelId: string,
    existingOwnership?: HubPermissionOwnership,
  ): Promise<ConfigureSupportHubResult>;
  applyHub(
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<ConfigureSupportHubResult>;
  restoreHub(guild: Guild, ownership: HubPermissionOwnership): Promise<void>;
  releaseHub(guild: Guild, ownership: HubPermissionOwnership): Promise<void>;
  releaseFormerHub(
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<void>;
  upsertInformationMessage(input: UpsertHubInformationInput): Promise<string>;
  deleteInformationMessage(
    guild: Guild,
    channelId: string,
    messageId?: string,
  ): Promise<void>;
}

type HubResolution =
  | Readonly<{ valid: true; channel: TextChannel; botMember: GuildMember }>
  | Readonly<{ valid: false; issues: readonly string[] }>;

const isManagedInformationMessage = (
  message: Message,
  botUserId: string,
): boolean =>
  message.author.id === botUserId &&
  message.content.includes(SUPPORT_HUB_INFORMATION_MARKER);

const isDiscordErrorCode = (error: unknown, code: number): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const isIrrecoverableFormerResourceError = (error: unknown): boolean =>
  [
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
  ].some((code) => isDiscordErrorCode(error, code));

const fetchTextChannel = async (
  guild: Guild,
  channelId: string,
  force = false,
): Promise<TextChannel | undefined> => {
  const channel = await guild.channels.fetch(channelId, { force });
  return channel?.type === ChannelType.GuildText ? channel : undefined;
};

const resolveHub = async (
  guild: Guild,
  channelId: string,
  force = false,
): Promise<HubResolution> => {
  const selected = await guild.channels.fetch(channelId, { force });
  if (selected === null) {
    return {
      valid: false,
      issues: ["The selected channel no longer exists in this server."],
    };
  }
  if (selected.type !== ChannelType.GuildText) {
    return {
      valid: false,
      issues: ["The support hub must be a standard text channel."],
    };
  }
  const channel = selected;

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  const missing = requiredBotPermissions
    .filter(([, permission]) => permissions?.has(permission) !== true)
    .map(([name]) => name);
  const issues = [
    ...(missing.length === 0
      ? []
      : [
          `Prod is missing required permissions in this channel: ${missing.join(", ")}.`,
        ]),
  ];
  return issues.length === 0
    ? { valid: true, channel, botMember }
    : { valid: false, issues };
};

const permissionState = (
  channel: TextChannel,
  targetId: string,
  name: HubProtectedPermissionName,
): HubPermissionState => {
  const overwrite = channel.permissionOverwrites.cache.get(targetId);
  const permission = protectedPermissionBits[name];
  if (overwrite?.allow.has(permission)) return "allow";
  if (overwrite?.deny.has(permission)) return "deny";
  return "unset";
};

const permissionSnapshot = (
  channel: TextChannel,
  targetId: string,
): HubPermissionOwnershipV2["everyone"] =>
  Object.freeze(
    Object.fromEntries(
      HUB_PROTECTED_PERMISSION_NAMES.map((name) => [
        name,
        permissionState(channel, targetId, name),
      ]),
    ) as Record<HubProtectedPermissionName, HubPermissionState>,
  );

const captureOwnership = (
  channel: TextChannel,
  guild: Guild,
  botMember: GuildMember,
): HubPermissionOwnershipV2 =>
  Object.freeze({
    version: 2,
    channelId: channel.id,
    botMemberId: botMember.id,
    everyone: permissionSnapshot(channel, guild.roles.everyone.id),
    bot: permissionSnapshot(channel, botMember.id),
  });

const stateValue = (state: HubPermissionState): boolean | null => {
  if (state === "allow") return true;
  if (state === "deny") return false;
  return null;
};

const restorationPatch = (
  channel: TextChannel,
  targetId: string,
  original: Readonly<
    Partial<Record<HubProtectedPermissionName, HubPermissionState>>
  >,
  ownedNames: readonly HubProtectedPermissionName[],
  ownedState: HubPermissionState,
): PermissionOverwriteOptions =>
  Object.fromEntries(
    ownedNames.flatMap((name) => {
      const originalState = original[name];
      return originalState !== undefined &&
        permissionState(channel, targetId, name) === ownedState
        ? [[name, stateValue(originalState)]]
        : [];
    }),
  );

const assertOwnershipIdentity = async (
  guild: Guild,
  ownership: HubPermissionOwnership,
): Promise<GuildMember> => {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (botMember.id !== ownership.botMemberId) {
    throw new Error(
      "Stored support hub permission ownership belongs to a different bot member",
    );
  }
  return botMember;
};

const applyOwnedPermissions = async (
  guild: Guild,
  channel: TextChannel,
  botMember: GuildMember,
  ownership: HubPermissionOwnership,
): Promise<void> => {
  const protectedNames =
    ownership.version === 1
      ? HUB_PROTECTED_PERMISSION_NAMES.filter(
          (name) => name !== "ManageThreads",
        )
      : HUB_PROTECTED_PERMISSION_NAMES;
  const botNames =
    ownership.version === 1
      ? HUB_BOT_PERMISSION_NAMES.filter((name) => name !== "ManageThreads")
      : HUB_BOT_PERMISSION_NAMES;
  await channel.permissionOverwrites.edit(
    guild.roles.everyone,
    Object.fromEntries(
      protectedNames.map((name) => [name, EMPTY_HUB_REPORTER_OVERWRITE[name]]),
    ),
    { reason: "Configure Prod's empty support hub privacy boundary" },
  );
  await channel.permissionOverwrites.edit(
    botMember,
    Object.fromEntries(
      botNames.map((name) => [name, SUPPORT_HUB_BOT_OVERWRITE[name]]),
    ),
    { reason: "Preserve Prod's support hub capabilities" },
  );
};

const upgradeOwnership = (
  ownership: HubPermissionOwnership,
  channel: TextChannel,
  guild: Guild,
  botMember: GuildMember,
): HubPermissionOwnershipV2 =>
  ownership.version === 2
    ? ownership
    : Object.freeze({
        version: 2,
        channelId: ownership.channelId,
        botMemberId: ownership.botMemberId,
        everyone: Object.freeze({
          ...ownership.everyone,
          ManageThreads: permissionState(
            channel,
            guild.roles.everyone.id,
            "ManageThreads",
          ),
        }),
        bot: Object.freeze({
          ...ownership.bot,
          ManageThreads: permissionState(
            channel,
            botMember.id,
            "ManageThreads",
          ),
        }),
      });

const informationMessageContent = (assistantIdentity: string): string =>
  [
    `## ${assistantIdentity} support`,
    "Use `/issue`, `/report`, or `/debugshare` to open an invite-only private support thread.",
    SUPPORT_HUB_INFORMATION_MARKER,
  ].join("\n\n");

const managedInformationMessages = async (
  channel: TextChannel,
  botMember: GuildMember,
  storedMessageId?: string,
): Promise<Message[]> => {
  const recent = await channel.messages.fetch({ limit: 100 });
  const managed = [...recent.values()].filter((message) =>
    isManagedInformationMessage(message, botMember.id),
  );
  if (
    storedMessageId !== undefined &&
    !managed.some(({ id }) => id === storedMessageId)
  ) {
    try {
      const stored = await channel.messages.fetch(storedMessageId);
      if (isManagedInformationMessage(stored, botMember.id))
        managed.push(stored);
    } catch (error) {
      if (!isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMessage)) {
        throw error;
      }
    }
  }
  return managed;
};

const reconcileInformationMessages = async (
  channel: TextChannel,
  botMember: GuildMember,
  payload: Readonly<{
    content: string;
    allowedMentions: Readonly<{ parse: readonly [] }>;
  }>,
  storedMessageId?: string,
): Promise<string> => {
  let managed = await managedInformationMessages(
    channel,
    botMember,
    storedMessageId,
  );
  if (managed.length === 0) {
    const created = await channel.send(payload);
    managed = await managedInformationMessages(
      channel,
      botMember,
      storedMessageId,
    );
    if (!managed.some(({ id }) => id === created.id)) managed.push(created);
  }

  const selected =
    managed.find(({ id }) => id === storedMessageId) ??
    managed.toSorted(
      (left, right) => left.createdTimestamp - right.createdTimestamp,
    )[0]!;
  await selected.edit(payload);
  await Promise.all(
    managed
      .filter(({ id }) => id !== selected.id)
      .map((duplicate) => duplicate.delete()),
  );
  return selected.id;
};

export const createSupportHubDiscord = (): SupportHubDiscord => {
  const releaseHubWithAccess = async (
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<void> => {
    const botMember = await assertOwnershipIdentity(guild, ownership);
    const channel = await fetchTextChannel(guild, ownership.channelId, true);
    if (channel === undefined) return;

    const protectedNames =
      ownership.version === 1
        ? HUB_PROTECTED_PERMISSION_NAMES.filter(
            (name) => name !== "ManageThreads",
          )
        : HUB_PROTECTED_PERMISSION_NAMES;
    const botNames =
      ownership.version === 1
        ? HUB_BOT_PERMISSION_NAMES.filter((name) => name !== "ManageThreads")
        : HUB_BOT_PERMISSION_NAMES;

    const everyonePatch = restorationPatch(
      channel,
      guild.roles.everyone.id,
      ownership.everyone,
      protectedNames,
      "deny",
    );
    if (Object.keys(everyonePatch).length > 0) {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        everyonePatch,
        { reason: "Release Prod's former support hub privacy boundary" },
      );
    }

    const refreshed =
      (await fetchTextChannel(guild, ownership.channelId, true)) ?? channel;
    const botPatch = restorationPatch(
      refreshed,
      botMember.id,
      ownership.bot,
      botNames,
      "allow",
    );
    if (Object.keys(botPatch).length > 0) {
      await refreshed.permissionOverwrites.edit(botMember, botPatch, {
        reason: "Release Prod's former support hub capabilities",
      });
    }
  };

  const releaseFormerHub = async (
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<void> => {
    try {
      await releaseHubWithAccess(guild, ownership);
    } catch (error) {
      if (!isIrrecoverableFormerResourceError(error)) throw error;
    }
  };

  const releaseHub = async (
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<void> => {
    try {
      await releaseHubWithAccess(guild, ownership);
    } catch (error) {
      if (!isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownChannel)) {
        throw error;
      }
    }
  };

  const restoreHub = async (
    guild: Guild,
    ownership: HubPermissionOwnership,
  ): Promise<void> => {
    const botMember = await assertOwnershipIdentity(guild, ownership);
    const channel = await fetchTextChannel(guild, ownership.channelId, true);
    if (channel === undefined) {
      throw new Error("The configured support hub no longer exists");
    }
    await applyOwnedPermissions(guild, channel, botMember, ownership);
    const postcondition = await resolveHub(guild, ownership.channelId, true);
    if (!postcondition.valid) {
      throw new Error(postcondition.issues.join(" "));
    }
  };

  return Object.freeze({
    validateHub: async (guild: Guild, channelId: string) => {
      const resolution = await resolveHub(guild, channelId);
      return resolution.valid
        ? { valid: true as const }
        : { valid: false as const, issues: resolution.issues };
    },
    prepareHub: async (
      guild: Guild,
      channelId: string,
      existingOwnership?: HubPermissionOwnership,
    ) => {
      const resolution = await resolveHub(guild, channelId);
      if (!resolution.valid) return resolution;
      if (
        existingOwnership !== undefined &&
        (existingOwnership.channelId !== channelId ||
          existingOwnership.botMemberId !== resolution.botMember.id)
      ) {
        throw new Error(
          "Existing support hub permission ownership does not match this channel and bot",
        );
      }
      const ownership =
        existingOwnership === undefined
          ? captureOwnership(resolution.channel, guild, resolution.botMember)
          : upgradeOwnership(
              existingOwnership,
              resolution.channel,
              guild,
              resolution.botMember,
            );
      return { valid: true as const, permissionOwnership: ownership };
    },
    applyHub: async (guild: Guild, ownership: HubPermissionOwnership) => {
      const resolution = await resolveHub(guild, ownership.channelId);
      if (!resolution.valid) return resolution;
      if (resolution.botMember.id !== ownership.botMemberId) {
        throw new Error(
          "Support hub permission ownership belongs to a different bot member",
        );
      }
      await applyOwnedPermissions(
        guild,
        resolution.channel,
        resolution.botMember,
        ownership,
      );
      const postcondition = await resolveHub(guild, ownership.channelId, true);
      return postcondition.valid
        ? { valid: true as const, permissionOwnership: ownership }
        : postcondition;
    },
    restoreHub,
    releaseHub,
    releaseFormerHub,
    upsertInformationMessage: async (input: UpsertHubInformationInput) => {
      const resolution = await resolveHub(input.guild, input.channelId);
      if (!resolution.valid) {
        throw new Error(resolution.issues.join(" "));
      }
      const payload = {
        content: informationMessageContent(input.assistantIdentity),
        allowedMentions: { parse: [] as const },
      };
      return reconcileInformationMessages(
        resolution.channel,
        resolution.botMember,
        payload,
        input.messageId,
      );
    },
    deleteInformationMessage: async (
      guild: Guild,
      channelId: string,
      messageId?: string,
    ) => {
      try {
        const channel = await fetchTextChannel(guild, channelId);
        if (channel === undefined) return;
        const botMember = guild.members.me ?? (await guild.members.fetchMe());
        const managed = await managedInformationMessages(
          channel,
          botMember,
          messageId,
        );
        await Promise.all(managed.map((message) => message.delete()));
      } catch (error) {
        if (!isIrrecoverableFormerResourceError(error)) throw error;
      }
    },
  });
};
