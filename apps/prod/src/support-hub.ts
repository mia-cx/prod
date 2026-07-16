import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type PermissionResolvable,
  type TextChannel,
} from "discord.js";

export const EMPTY_HUB_REPORTER_OVERWRITE = Object.freeze({
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
} as const);

const requiredBotPermissions = Object.freeze([
  ["View Channel", PermissionFlagsBits.ViewChannel],
  ["Manage Roles (channel permission overwrites)", PermissionFlagsBits.ManageRoles],
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

export type ConfigureSupportHubResult = SupportHubValidation;

export type UpsertHubInformationInput = Readonly<{
  guild: Guild;
  channelId: string;
  assistantIdentity: string;
  messageId?: string;
}>;

export interface SupportHubDiscord {
  validateHub(guild: Guild, channelId: string): Promise<SupportHubValidation>;
  configureHub(
    guild: Guild,
    channelId: string,
  ): Promise<ConfigureSupportHubResult>;
  upsertInformationMessage(input: UpsertHubInformationInput): Promise<string>;
  deleteInformationMessage(
    guild: Guild,
    channelId: string,
    messageId: string,
  ): Promise<void>;
}

type HubResolution =
  | Readonly<{ valid: true; channel: TextChannel }>
  | Readonly<{ valid: false; issues: readonly string[] }>;

const isDiscordErrorCode = (error: unknown, code: number): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

const resolveHub = async (
  guild: Guild,
  channelId: string,
): Promise<HubResolution> => {
  const channel = await guild.channels.fetch(channelId);
  if (channel === null) {
    return {
      valid: false,
      issues: ["The selected channel no longer exists in this server."],
    };
  }
  if (channel.type !== ChannelType.GuildText) {
    return {
      valid: false,
      issues: ["The support hub must be a standard text channel."],
    };
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  const missing = requiredBotPermissions
    .filter(([, permission]) => permissions?.has(permission) !== true)
    .map(([name]) => name);
  if (missing.length > 0) {
    return {
      valid: false,
      issues: [
        `Prod is missing required permissions in this channel: ${missing.join(", ")}.`,
      ],
    };
  }

  return { valid: true, channel };
};

const informationMessageContent = (assistantIdentity: string): string =>
  [
    `## ${assistantIdentity} support`,
    "Use `/issue`, `/report`, or `/debugshare` to open a private support ticket.",
    "Ticket conversations stay in invite-only private threads. Do not post ticket details in this channel.",
  ].join("\n\n");

export const createSupportHubDiscord = (): SupportHubDiscord =>
  Object.freeze({
    validateHub: async (guild: Guild, channelId: string) => {
      const resolution = await resolveHub(guild, channelId);
      return resolution.valid
        ? { valid: true as const }
        : { valid: false as const, issues: resolution.issues };
    },
    configureHub: async (guild: Guild, channelId: string) => {
      const resolution = await resolveHub(guild, channelId);
      if (!resolution.valid) return resolution;

      await resolution.channel.permissionOverwrites.edit(
        guild.roles.everyone,
        EMPTY_HUB_REPORTER_OVERWRITE,
        { reason: "Configure Prod's empty support hub privacy boundary" },
      );
      return { valid: true as const };
    },
    upsertInformationMessage: async (input: UpsertHubInformationInput) => {
      const resolution = await resolveHub(input.guild, input.channelId);
      if (!resolution.valid) {
        throw new Error(resolution.issues.join(" "));
      }
      const payload = {
        content: informationMessageContent(input.assistantIdentity),
        allowedMentions: { parse: [] as const },
      };
      if (input.messageId !== undefined) {
        try {
          const message = await resolution.channel.messages.fetch(
            input.messageId,
          );
          await message.edit(payload);
          return message.id;
        } catch (error) {
          if (!isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMessage)) {
            throw error;
          }
        }
      }

      const message = await resolution.channel.send(payload);
      return message.id;
    },
    deleteInformationMessage: async (
      guild: Guild,
      channelId: string,
      messageId: string,
    ) => {
      let resolution: HubResolution;
      try {
        resolution = await resolveHub(guild, channelId);
      } catch (error) {
        if (isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownChannel)) return;
        throw error;
      }
      if (!resolution.valid) return;
      try {
        const message = await resolution.channel.messages.fetch(messageId);
        await message.delete();
      } catch (error) {
        if (!isDiscordErrorCode(error, RESTJSONErrorCodes.UnknownMessage)) {
          throw error;
        }
      }
    },
  });
