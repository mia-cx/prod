import {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  RESTJSONErrorCodes,
  type Guild,
  type PermissionResolvable,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { REPORTER_TICKET_HUB_OVERWRITE } from "../src/reporter-hub-access.js";

import {
  createSupportHubDiscord,
  EMPTY_HUB_REPORTER_OVERWRITE,
  REQUIRED_HUB_BOT_PERMISSION_NAMES,
  SUPPORT_HUB_BOT_OVERWRITE,
  SUPPORT_HUB_INFORMATION_MARKER,
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
      type: OverwriteType;
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
        type: roleCache.has(id) ? OverwriteType.Role : OverwriteType.Member,
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
  const everyone = { id: "guild-1" };
  const botMember = { id: "bot-1" };
  const roleCache = new Collection<
    string,
    { id: string; tags?: { botId?: string } }
  >([[everyone.id, everyone]]);
  type TestMessage = {
    id: string;
    author: { id: string };
    content: string;
    createdTimestamp: number;
    edit: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  const messageCache = new Collection<string, TestMessage>();
  const activeThreads = new Collection();
  const archivedThreads = new Collection();
  let nextMessage = 1;
  const addMessage = (
    id: string,
    content: string,
    authorId = botMember.id,
    createdTimestamp = nextMessage,
  ): TestMessage => {
    const message: TestMessage = {
      id,
      author: { id: authorId },
      content,
      createdTimestamp,
      edit: vi.fn(async (payload: Readonly<{ content: string }>) => {
        message.content = payload.content;
        return message;
      }),
      delete: vi.fn(async () => {
        messageCache.delete(id);
      }),
    };
    messageCache.set(id, message);
    nextMessage += 1;
    return message;
  };
  const fetchMessage = vi.fn(async (input: string | { limit: number }) => {
    if (typeof input !== "string") return messageCache;
    const message = messageCache.get(input);
    if (message !== undefined) return message;
    throw { code: RESTJSONErrorCodes.UnknownMessage };
  });
  const send = vi.fn(async (payload: Readonly<{ content: string }>) =>
    addMessage(`message-${nextMessage}`, payload.content),
  );
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
    threads: {
      fetchActive: vi.fn().mockResolvedValue({ threads: activeThreads }),
      fetchArchived: vi.fn().mockResolvedValue({
        threads: archivedThreads,
        hasMore: false,
      }),
    },
    messages: { fetch: fetchMessage },
    send,
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
    members: { me: botMember, fetchMe: vi.fn() },
    roles: { everyone, cache: roleCache },
  } as unknown as Guild;
  const addOverwrite = (
    id: string,
    allow: readonly PermissionResolvable[] = [],
    deny: readonly PermissionResolvable[] = [],
  ) => {
    overwriteCache.set(id, {
      id,
      type: roleCache.has(id) ? OverwriteType.Role : OverwriteType.Member,
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
    messageCache,
    activeThreads,
    archivedThreads,
    addMessage,
    roleCache,
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
    missing.channel.threads.fetchArchived.mockRejectedValue(
      new Error("Discord denied thread history access"),
    );
    const result = await hub.validateHub(missing.guild, "hub-1");
    expect(result).toEqual({
      valid: false,
      issues: [expect.stringContaining(REQUIRED_HUB_BOT_PERMISSION_NAMES[0]!)],
    });
    for (const permissionName of REQUIRED_HUB_BOT_PERMISSION_NAMES) {
      expect(result.valid ? "" : result.issues[0]).toContain(permissionName);
    }
    expect(missing.channel.threads.fetchActive).not.toHaveBeenCalled();
    expect(missing.channel.threads.fetchArchived).not.toHaveBeenCalled();
  });

  it("applies the empty-hub reporter overwrite idempotently", async () => {
    const hub = createSupportHubDiscord();
    const { guild, everyone, botMember, editOverwrite, effectiveFor } =
      fixture();

    const configured = await hub.prepareHub(guild, "hub-1");
    expect(configured.valid).toBe(true);
    if (!configured.valid) return;
    await expect(
      hub.applyHub(guild, configured.permissionOwnership),
    ).resolves.toEqual(configured);
    await expect(
      hub.applyHub(guild, configured.permissionOwnership),
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
    expect(reporter.has(PermissionFlagsBits.ManageThreads)).toBe(false);
    expect(EMPTY_HUB_REPORTER_OVERWRITE).toEqual({
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      ManageThreads: false,
    });
  });

  it("rejects unrelated history but accepts Prod's managed information message", async () => {
    const hub = createSupportHubDiscord();
    const unsafe = fixture();
    unsafe.addMessage("history-1", "Prior support details");

    await expect(hub.validateHub(unsafe.guild, "hub-1")).resolves.toEqual({
      valid: false,
      issues: [expect.stringContaining("Remove all messages")],
    });

    const managed = fixture();
    managed.addMessage(
      "information-1",
      `Prod information\n\n${SUPPORT_HUB_INFORMATION_MARKER}`,
      managed.botMember.id,
    );
    await expect(hub.validateHub(managed.guild, "hub-1")).resolves.toEqual({
      valid: true,
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

  it("accepts the exact managed reporter ticket overwrite", async () => {
    const hub = createSupportHubDiscord();
    const managed = fixture();
    managed.addOverwrite(
      "reporter-1",
      [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.UseApplicationCommands,
      ],
      [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.ManageThreads,
      ],
    );

    await expect(hub.validateHub(managed.guild, "hub-1")).resolves.toEqual({
      valid: true,
    });
    expect(REPORTER_TICKET_HUB_OVERWRITE.SendMessagesInThreads).toBe(true);
  });

  it("rejects hubs with public threads and can remove later drift", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure one"))
      .mockRejectedValueOnce(new Error("transient failure two"))
      .mockResolvedValue(undefined);
    state.activeThreads.set("public-1", {
      id: "public-1",
      type: ChannelType.PublicThread,
      delete: remove,
    });

    await expect(hub.validateHub(state.guild, "hub-1")).resolves.toEqual({
      valid: false,
      issues: [expect.stringContaining("Remove public threads")],
    });
    await expect(hub.deletePublicThreads(state.guild, "hub-1")).resolves.toBe(
      1,
    );
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("rejects active and archived private threads when adopting a hub", async () => {
    const hub = createSupportHubDiscord();
    for (const location of ["active", "archived"] as const) {
      const state = fixture();
      state[`${location}Threads`].set("private-1", {
        id: "private-1",
        type: ChannelType.PrivateThread,
      });

      await expect(hub.prepareHub(state.guild, "hub-1")).resolves.toEqual({
        valid: false,
        issues: [expect.stringContaining("Remove private threads")],
      });
      expect(state.editOverwrite).not.toHaveBeenCalled();
    }
  });

  it("rejects channel-specific Manage Threads grants", async () => {
    const hub = createSupportHubDiscord();
    for (const targetId of ["role-1", "member-1"]) {
      const state = fixture();
      state.addOverwrite(targetId, [PermissionFlagsBits.ManageThreads]);

      await expect(hub.validateHub(state.guild, "hub-1")).resolves.toEqual({
        valid: false,
        issues: [expect.stringContaining("channel-specific role or member")],
      });
    }
  });

  it("upgrades version-one ownership without losing Manage Threads state", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    state.addOverwrite(state.everyone.id, [PermissionFlagsBits.ManageThreads]);
    state.addOverwrite(
      state.botMember.id,
      [PermissionFlagsBits.ManageThreads],
    );
    const versionOneOwnership = {
      version: 1 as const,
      channelId: "hub-1",
      botMemberId: "bot-1",
      everyone: {
        SendMessages: "unset" as const,
        SendMessagesInThreads: "unset" as const,
        CreatePublicThreads: "unset" as const,
        CreatePrivateThreads: "unset" as const,
      },
      bot: {
        SendMessages: "unset" as const,
        SendMessagesInThreads: "unset" as const,
        CreatePublicThreads: "unset" as const,
        CreatePrivateThreads: "unset" as const,
      },
    };

    const prepared = await hub.prepareHub(
      state.guild,
      "hub-1",
      versionOneOwnership,
    );
    expect(prepared.valid).toBe(true);
    if (!prepared.valid) return;
    expect(prepared.permissionOwnership).toMatchObject({
      version: 2,
      everyone: { ManageThreads: "allow" },
      bot: { ManageThreads: "allow" },
    });

    await hub.applyHub(state.guild, prepared.permissionOwnership);
    await hub.releaseHub(state.guild, prepared.permissionOwnership);
    expect(
      state.overwriteCache
        .get(state.everyone.id)
        ?.allow.has(PermissionFlagsBits.ManageThreads),
    ).toBe(true);
    expect(
      state.overwriteCache
        .get(state.botMember.id)
        ?.allow.has(PermissionFlagsBits.ManageThreads),
    ).toBe(true);
  });

  it("treats a concurrently deleted public thread as already cleaned", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    const remove = vi
      .fn()
      .mockRejectedValue({ code: RESTJSONErrorCodes.UnknownChannel });
    state.activeThreads.set("public-gone", {
      id: "public-gone",
      type: ChannelType.PublicThread,
      delete: remove,
    });

    await expect(hub.deletePublicThreads(state.guild, "hub-1")).resolves.toBe(
      1,
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects the reporter permission shape when it belongs to a role", async () => {
    const hub = createSupportHubDiscord();
    const managedRole = fixture();
    managedRole.roleCache.set("support-role", { id: "support-role" });
    managedRole.addOverwrite(
      "support-role",
      [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.UseApplicationCommands,
      ],
      [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    );

    await expect(hub.validateHub(managedRole.guild, "hub-1")).resolves.toEqual({
      valid: false,
      issues: [expect.stringContaining("channel-specific role or member")],
    });
  });

  it("accepts the bot's managed integration role overwrite", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    state.roleCache.set("bot-role", {
      id: "bot-role",
      tags: { botId: state.botMember.id },
    });
    state.addOverwrite("bot-role", [PermissionFlagsBits.SendMessages]);

    await expect(hub.validateHub(state.guild, "hub-1")).resolves.toEqual({
      valid: true,
    });
  });

  it("releases only still-owned permission bits on a former hub", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    state.addOverwrite(
      state.everyone.id,
      [PermissionFlagsBits.SendMessages],
      [PermissionFlagsBits.AddReactions],
    );
    const configured = await hub.prepareHub(state.guild, "hub-1");
    expect(configured.valid).toBe(true);
    if (!configured.valid) return;
    await hub.applyHub(state.guild, configured.permissionOwnership);

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

  it("finishes cleanup when a former channel is gone or inaccessible", async () => {
    const hub = createSupportHubDiscord();
    for (const code of [
      RESTJSONErrorCodes.UnknownChannel,
      RESTJSONErrorCodes.MissingAccess,
    ]) {
      const state = fixture();
      const prepared = await hub.prepareHub(state.guild, "hub-1");
      expect(prepared.valid).toBe(true);
      if (!prepared.valid) continue;
      vi.mocked(state.guild.channels.fetch).mockRejectedValue({ code });

      await expect(
        hub.releaseFormerHub(state.guild, prepared.permissionOwnership),
      ).resolves.toBeUndefined();
      if (code === RESTJSONErrorCodes.UnknownChannel) {
        await expect(
          hub.releaseHub(state.guild, prepared.permissionOwnership),
        ).resolves.toBeUndefined();
      }
      await expect(
        hub.deleteInformationMessage(state.guild, "hub-1"),
      ).resolves.toBeUndefined();
    }

    const forbidden = fixture();
    const prepared = await hub.prepareHub(forbidden.guild, "hub-1");
    expect(prepared.valid).toBe(true);
    if (!prepared.valid) return;
    await hub.applyHub(forbidden.guild, prepared.permissionOwnership);
    forbidden.editOverwrite.mockRejectedValueOnce({
      code: RESTJSONErrorCodes.MissingPermissions,
    });

    await expect(
      hub.releaseFormerHub(forbidden.guild, prepared.permissionOwnership),
    ).resolves.toBeUndefined();
  });

  it("creates one information message and edits that message on refresh", async () => {
    const hub = createSupportHubDiscord();
    const { guild, messageCache, send } = fixture();

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
    const content = messageCache.get("message-1")?.content ?? "";
    expect(content).toContain("## Support Guide support");
    expect(content).toContain("`/issue`, `/report`, or `/debugshare`");
    expect(content).toContain("Keep this channel empty");
    expect(content).not.toContain("Opening summary:");
    expect(messageCache.get("message-1")?.edit).toHaveBeenLastCalledWith({
      content,
      allowedMentions: { parse: [] },
    });
  });

  it("refuses to add an information message while unrelated history exists", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    const unrelated = state.addMessage(
      "unrelated",
      "A different bot-authored message",
    );

    await expect(
      hub.upsertInformationMessage({
        guild: state.guild,
        channelId: "hub-1",
        assistantIdentity: "Prod",
      }),
    ).rejects.toThrow("Remove all messages");

    expect(state.send).not.toHaveBeenCalled();
    expect(state.messageCache.has("unrelated")).toBe(true);
    expect(unrelated.delete).not.toHaveBeenCalled();
  });

  it("reconciles duplicate marked messages and prefers the persisted one", async () => {
    const hub = createSupportHubDiscord();
    const state = fixture();
    const oldest = state.addMessage(
      "message-old",
      `Old copy\n\n${SUPPORT_HUB_INFORMATION_MARKER}`,
      state.botMember.id,
      1,
    );
    const persisted = state.addMessage(
      "message-persisted",
      `Persisted copy\n\n${SUPPORT_HUB_INFORMATION_MARKER}`,
      state.botMember.id,
      2,
    );

    await expect(
      hub.upsertInformationMessage({
        guild: state.guild,
        channelId: "hub-1",
        assistantIdentity: "Prod",
        messageId: persisted.id,
      }),
    ).resolves.toBe(persisted.id);

    expect(oldest.delete).toHaveBeenCalledOnce();
    expect(persisted.delete).not.toHaveBeenCalled();
    expect(state.messageCache.size).toBe(1);
  });

  it("does not replace a stored message when Discord fails transiently", async () => {
    const hub = createSupportHubDiscord();

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
    const message = stale.addMessage(
      "message-1",
      `Managed\n\n${SUPPORT_HUB_INFORMATION_MARKER}`,
    );
    const unrelated = stale.addMessage("unrelated", "Other bot message");

    await hub.deleteInformationMessage(stale.guild, "hub-1", "message-1");

    expect(message.delete).toHaveBeenCalledOnce();
    expect(unrelated.delete).not.toHaveBeenCalled();
  });
});
