import {
  ChannelType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type PermissionResolvable,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSupportHubDiscord,
  EMPTY_HUB_REPORTER_OVERWRITE,
  REQUIRED_HUB_BOT_PERMISSION_NAMES,
} from "../src/support-hub.js";

const allRequiredPermissions = new Set<PermissionResolvable>([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.EmbedLinks,
]);

const fixture = (
  permissions: ReadonlySet<PermissionResolvable> = allRequiredPermissions,
) => {
  const editOverwrite = vi.fn().mockResolvedValue(undefined);
  const fetchMessage = vi.fn();
  const send = vi.fn();
  const channel = {
    id: "hub-1",
    type: ChannelType.GuildText,
    permissionsFor: vi.fn(() => ({
      has: (permission: PermissionResolvable) => permissions.has(permission),
    })),
    permissionOverwrites: { edit: editOverwrite },
    messages: { fetch: fetchMessage },
    send,
  };
  const everyone = { id: "guild-1" };
  const guild = {
    id: "guild-1",
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
    members: { me: { id: "bot-1" }, fetchMe: vi.fn() },
    roles: { everyone },
  } as unknown as Guild;
  return { guild, channel, everyone, editOverwrite, fetchMessage, send };
};

describe("Discord support hub", () => {
  it("accepts only standard text channels with every effective bot permission", async () => {
    const hub = createSupportHubDiscord();
    const valid = fixture();
    await expect(hub.validateHub(valid.guild, "hub-1")).resolves.toEqual({
      valid: true,
    });

    const wrongType = fixture();
    wrongType.channel.type = ChannelType.GuildVoice as ChannelType.GuildText;
    await expect(hub.validateHub(wrongType.guild, "hub-1")).resolves.toEqual({
      valid: false,
      issues: ["The support hub must be a standard text channel."],
    });

    const missing = fixture(new Set());
    const result = await hub.validateHub(missing.guild, "hub-1");
    expect(result).toEqual({
      valid: false,
      issues: [expect.stringContaining(REQUIRED_HUB_BOT_PERMISSION_NAMES[0]!)],
    });
    for (const permissionName of REQUIRED_HUB_BOT_PERMISSION_NAMES) {
      expect(result.valid ? "" : result.issues[0]).toContain(permissionName);
    }
  });

  it("applies the empty-hub reporter overwrite idempotently", async () => {
    const hub = createSupportHubDiscord();
    const { guild, everyone, editOverwrite } = fixture();

    await expect(hub.configureHub(guild, "hub-1")).resolves.toEqual({
      valid: true,
    });
    await expect(hub.configureHub(guild, "hub-1")).resolves.toEqual({
      valid: true,
    });

    expect(editOverwrite).toHaveBeenCalledTimes(2);
    expect(editOverwrite).toHaveBeenLastCalledWith(
      everyone,
      EMPTY_HUB_REPORTER_OVERWRITE,
      { reason: "Configure Prod's empty support hub privacy boundary" },
    );
    expect(EMPTY_HUB_REPORTER_OVERWRITE).toEqual({
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    });
  });

  it("creates one information message and edits that message on refresh", async () => {
    const hub = createSupportHubDiscord();
    const { guild, fetchMessage, send } = fixture();
    const edit = vi.fn().mockResolvedValue(undefined);
    const existing = { id: "message-1", edit };
    send.mockResolvedValue(existing);
    fetchMessage.mockResolvedValue(existing);

    const createdId = await hub.upsertInformationMessage({
      guild,
      channelId: "hub-1",
      assistantIdentity: "Prod",
    });
    const refreshedId = await hub.upsertInformationMessage({
      guild,
      channelId: "hub-1",
      assistantIdentity: "Support Guide",
      messageId: createdId,
    });

    expect(createdId).toBe("message-1");
    expect(refreshedId).toBe("message-1");
    expect(send).toHaveBeenCalledOnce();
    expect(fetchMessage).toHaveBeenCalledWith("message-1");
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("## Support Guide support"),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it("replaces only a confirmed missing information message", async () => {
    const hub = createSupportHubDiscord();
    const missing = fixture();
    missing.fetchMessage.mockRejectedValue({
      code: RESTJSONErrorCodes.UnknownMessage,
    });
    missing.send.mockResolvedValue({ id: "message-2" });

    await expect(
      hub.upsertInformationMessage({
        guild: missing.guild,
        channelId: "hub-1",
        assistantIdentity: "Prod",
        messageId: "message-1",
      }),
    ).resolves.toBe("message-2");
    expect(missing.send).toHaveBeenCalledOnce();

    const transient = fixture();
    transient.fetchMessage.mockRejectedValue(new Error("Discord unavailable"));
    await expect(
      hub.upsertInformationMessage({
        guild: transient.guild,
        channelId: "hub-1",
        assistantIdentity: "Prod",
        messageId: "message-1",
      }),
    ).rejects.toThrow("Discord unavailable");
    expect(transient.send).not.toHaveBeenCalled();
  });

  it("deletes an old managed message even after required bot permissions change", async () => {
    const hub = createSupportHubDiscord();
    const stale = fixture(new Set());
    const remove = vi.fn().mockResolvedValue(undefined);
    stale.fetchMessage.mockResolvedValue({ delete: remove });

    await hub.deleteInformationMessage(stale.guild, "hub-1", "message-1");

    expect(stale.fetchMessage).toHaveBeenCalledWith("message-1");
    expect(remove).toHaveBeenCalledOnce();
  });
});
