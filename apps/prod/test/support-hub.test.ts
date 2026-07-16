import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  RESTJSONErrorCodes,
  type Guild,
  type PermissionResolvable,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createSupportHubDiscord,
  EMPTY_HUB_REPORTER_OVERWRITE,
  REQUIRED_HUB_BOT_PERMISSION_NAMES,
  SUPPORT_HUB_BOT_OVERWRITE,
} from "../src/support-hub.js";

const allRequiredPermissions: readonly PermissionResolvable[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.EmbedLinks,
];

const fixture = (
  permissions: readonly PermissionResolvable[] = allRequiredPermissions,
) => {
  const overwriteCache = new Collection<
    string,
    {
      id: string;
      allow: PermissionsBitField;
      deny: PermissionsBitField;
    }
  >();
  const editOverwrite = vi.fn(
    async (
      target: string | Readonly<{ id: string }>,
      patch: Readonly<Record<string, boolean | null | undefined>>,
    ) => {
      const id = typeof target === "string" ? target : target.id;
      const overwrite = overwriteCache.get(id) ?? {
        id,
        allow: new PermissionsBitField(),
        deny: new PermissionsBitField(),
      };
      for (const [name, value] of Object.entries(patch)) {
        const permission =
          PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
        if (permission === undefined) continue;
        overwrite.allow.remove(permission);
        overwrite.deny.remove(permission);
        if (value === true) overwrite.allow.add(permission);
        if (value === false) overwrite.deny.add(permission);
      }
      overwriteCache.set(id, overwrite);
    },
  );
  const fetchMessage = vi.fn();
  const send = vi.fn();
  const everyone = { id: "guild-1" };
  const botMember = { id: "bot-1" };
  const effectiveFor = (
    memberId: string,
    roleIds: readonly string[] = [],
  ): PermissionsBitField => {
    const effective = new PermissionsBitField(permissions);
    const apply = (id: string) => {
      const overwrite = overwriteCache.get(id);
      if (overwrite === undefined) return;
      effective.remove(overwrite.deny);
      effective.add(overwrite.allow);
    };
    apply(everyone.id);
    const roleAllows = new PermissionsBitField();
    const roleDenies = new PermissionsBitField();
    for (const roleId of roleIds) {
      const overwrite = overwriteCache.get(roleId);
      if (overwrite === undefined) continue;
      roleAllows.add(overwrite.allow);
      roleDenies.add(overwrite.deny);
    }
    effective.remove(roleDenies);
    effective.add(roleAllows);
    apply(memberId);
    return effective;
  };
  const channel = {
    id: "hub-1",
    type: ChannelType.GuildText,
    permissionsFor: vi.fn((member: Readonly<{ id: string }>) =>
      effectiveFor(member.id),
    ),
    permissionOverwrites: { edit: editOverwrite, cache: overwriteCache },
    messages: { fetch: fetchMessage },
    send,
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
    members: { me: botMember, fetchMe: vi.fn() },
    roles: { everyone },
  } as unknown as Guild;
  const addOverwrite = (
    id: string,
    allow: readonly PermissionResolvable[] = [],
    deny: readonly PermissionResolvable[] = [],
  ) => {
    overwriteCache.set(id, {
      id,
      allow: new PermissionsBitField(allow),
      deny: new PermissionsBitField(deny),
    });
  };
  return {
    guild,
    channel,
    everyone,
    botMember,
    overwriteCache,
    editOverwrite,
    fetchMessage,
    send,
    effectiveFor,
    addOverwrite,
  };
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

    const missing = fixture([]);
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
    const { guild, everyone, botMember, editOverwrite, effectiveFor } =
      fixture();

    const configured = await hub.configureHub(guild, "hub-1");
    expect(configured.valid).toBe(true);
    if (!configured.valid) return;
    await expect(
      hub.configureHub(guild, "hub-1", configured.permissionOwnership),
    ).resolves.toEqual(configured);

    expect(editOverwrite).toHaveBeenCalledTimes(4);
    expect(editOverwrite).toHaveBeenCalledWith(
      everyone,
      EMPTY_HUB_REPORTER_OVERWRITE,
      { reason: "Configure Prod's empty support hub privacy boundary" },
    );
    expect(editOverwrite).toHaveBeenCalledWith(
      botMember,
      SUPPORT_HUB_BOT_OVERWRITE,
      { reason: "Preserve Prod's support hub capabilities" },
    );
    for (const permission of allRequiredPermissions) {
      expect(effectiveFor(botMember.id).has(permission)).toBe(true);
    }
    const reporter = effectiveFor("reporter-1");
    expect(reporter.has(PermissionFlagsBits.SendMessages)).toBe(false);
    expect(reporter.has(PermissionFlagsBits.SendMessagesInThreads)).toBe(false);
    expect(reporter.has(PermissionFlagsBits.CreatePublicThreads)).toBe(false);
    expect(reporter.has(PermissionFlagsBits.CreatePrivateThreads)).toBe(false);
    expect(EMPTY_HUB_REPORTER_OVERWRITE).toEqual({
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    });
  });

  it("rejects non-bot role and member allows that would bypass hub privacy", async () => {
    const hub = createSupportHubDiscord();
    for (const targetId of ["role-1", "reporter-1"]) {
      const conflict = fixture();
      conflict.addOverwrite(targetId, [PermissionFlagsBits.SendMessages]);

      const result = await hub.validateHub(conflict.guild, "hub-1");

      expect(result).toEqual({
        valid: false,
        issues: [expect.stringContaining("channel-specific role or member")],
      });
      expect(conflict.editOverwrite).not.toHaveBeenCalled();
    }
  });

  it("releases only still-owned permission bits on a former hub", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    state.addOverwrite(
      state.everyone.id,
      [PermissionFlagsBits.SendMessages],
      [PermissionFlagsBits.AddReactions],
    );
    const configured = await hub.configureHub(state.guild, "hub-1");
    expect(configured.valid).toBe(true);
    if (!configured.valid) return;

    // An administrator deliberately changes this bit after Prod's setup.
    await state.channel.permissionOverwrites.edit(state.everyone, {
      CreatePublicThreads: true,
    });
    await hub.releaseHub(state.guild, configured.permissionOwnership);

    const everyone = state.overwriteCache.get(state.everyone.id)!;
    expect(everyone.allow.has(PermissionFlagsBits.SendMessages)).toBe(true);
    expect(everyone.allow.has(PermissionFlagsBits.CreatePublicThreads)).toBe(
      true,
    );
    expect(everyone.deny.has(PermissionFlagsBits.AddReactions)).toBe(true);
    const bot = state.overwriteCache.get(state.botMember.id)!;
    expect(bot.allow.has(PermissionFlagsBits.SendMessages)).toBe(false);
    expect(bot.allow.has(PermissionFlagsBits.SendMessagesInThreads)).toBe(
      false,
    );
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
    const stale = fixture([]);
    const remove = vi.fn().mockResolvedValue(undefined);
    stale.fetchMessage.mockResolvedValue({ delete: remove });

    await hub.deleteInformationMessage(stale.guild, "hub-1", "message-1");

    expect(stale.fetchMessage).toHaveBeenCalledWith("message-1");
    expect(remove).toHaveBeenCalledOnce();
  });
});
