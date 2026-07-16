import { describe, expect, it } from "vitest";

import {
  createDiscordAuthorizationContext,
  createDiscordUserSubject,
  InvalidDiscordAuthorizationContextError,
  type DiscordGuildLike,
  type DiscordMemberLike,
} from "../src/index.js";

const guild = {
  id: "guild-1",
  ownerId: "owner-1",
} satisfies DiscordGuildLike;

const member = (
  overrides: Partial<DiscordMemberLike> = {},
): DiscordMemberLike => ({
  id: "user-1",
  guild,
  roles: {
    cache: new Map([
      [guild.id, { id: guild.id }],
      ["role-2", { id: "role-2" }],
      ["role-1", { id: "role-1" }],
    ]),
  },
  permissions: { has: () => false },
  ...overrides,
});

describe("Discord authorization context adapter", () => {
  it("derives a complete guild/category/channel hierarchy", () => {
    expect(
      createDiscordAuthorizationContext({
        guild,
        channel: {
          id: "channel-1",
          guildId: guild.id,
          parentId: "category-1",
        },
      }),
    ).toEqual({
      guildId: guild.id,
      categoryId: "category-1",
      channelId: "channel-1",
    });
  });

  it("derives a thread category through its parent channel", () => {
    expect(
      createDiscordAuthorizationContext({
        guild,
        channel: {
          id: "thread-1",
          guildId: guild.id,
          parentId: "hub-channel-1",
          parent: { parentId: "category-1" },
          isThread: () => true,
        },
      }),
    ).toEqual({
      guildId: guild.id,
      categoryId: "category-1",
      channelId: "thread-1",
    });
  });

  it("supports category-only and uncategorized channel contexts", () => {
    expect(
      createDiscordAuthorizationContext({
        guild,
        category: { id: "category-1", guildId: guild.id },
      }),
    ).toEqual({ guildId: guild.id, categoryId: "category-1" });
    expect(
      createDiscordAuthorizationContext({
        guild,
        channel: { id: "channel-1", guildId: guild.id, parentId: null },
      }),
    ).toEqual({ guildId: guild.id, channelId: "channel-1" });
  });

  it("rejects cross-guild and mismatched category resources", () => {
    expect(() =>
      createDiscordAuthorizationContext({
        guild,
        category: { id: "category-1", guildId: "guild-2" },
      }),
    ).toThrow(InvalidDiscordAuthorizationContextError);
    expect(() =>
      createDiscordAuthorizationContext({
        guild,
        channel: {
          id: "channel-1",
          guildId: "guild-2",
          parentId: null,
        },
      }),
    ).toThrow(InvalidDiscordAuthorizationContextError);
    expect(() =>
      createDiscordAuthorizationContext({
        guild,
        category: { id: "category-1", guildId: guild.id },
        channel: {
          id: "channel-1",
          guildId: guild.id,
          parentId: "category-2",
        },
      }),
    ).toThrow(InvalidDiscordAuthorizationContextError);
  });

  it("requires a thread parent to derive a trustworthy category", () => {
    expect(() =>
      createDiscordAuthorizationContext({
        guild,
        channel: {
          id: "thread-1",
          guildId: guild.id,
          parentId: "hub-channel-1",
          parent: null,
          isThread: () => true,
        },
      }),
    ).toThrow(InvalidDiscordAuthorizationContextError);
  });
});

describe("Discord user subject adapter", () => {
  it("expands roles without leaking context identifiers into the subject", () => {
    const context = createDiscordAuthorizationContext({ guild });
    const subject = createDiscordUserSubject(member(), context);

    expect(subject).toEqual({
      subjectType: "user",
      subjectId: "user-1",
      attributes: {
        discordRoleIds: ["role-1", "role-2"],
        isGuildOwner: false,
        isAdministrator: false,
        canManageGuild: false,
        isApplicationOperator: false,
      },
    });
    expect(subject).not.toHaveProperty("guildId");
    expect(subject.attributes.discordRoleIds).not.toContain(guild.id);
  });

  it("derives immutable owner and administrator break-glass attributes", () => {
    const context = createDiscordAuthorizationContext({ guild });
    const subject = createDiscordUserSubject(
      member({
        id: guild.ownerId,
        permissions: { has: () => true },
      }),
      context,
    );

    expect(subject.attributes).toMatchObject({
      isGuildOwner: true,
      isAdministrator: true,
      canManageGuild: true,
    });
    expect(Object.isFrozen(subject.attributes.discordRoleIds)).toBe(true);
  });

  it("derives application operator status from trusted application IDs", () => {
    const context = createDiscordAuthorizationContext({ guild });
    const subject = createDiscordUserSubject(member(), context, {
      isApplicationOperator: (userId) => userId === "user-1",
    });

    expect(subject.attributes.isApplicationOperator).toBe(true);
  });

  it("derives the Manage Server configuration capability", () => {
    const context = createDiscordAuthorizationContext({ guild });
    const subject = createDiscordUserSubject(
      member({
        permissions: {
          has: (permission) => permission === "ManageGuild",
        },
      }),
      context,
    );

    expect(subject.attributes).toMatchObject({
      isAdministrator: false,
      canManageGuild: true,
    });
  });

  it("rejects a member from another guild", () => {
    const context = createDiscordAuthorizationContext({ guild });
    expect(() =>
      createDiscordUserSubject(
        member({ guild: { id: "guild-2", ownerId: "owner-2" } }),
        context,
      ),
    ).toThrow(InvalidDiscordAuthorizationContextError);
  });
});
