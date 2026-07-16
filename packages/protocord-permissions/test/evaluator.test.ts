import { describe, expect, it } from "vitest";

import {
  AuthorizationResourceMismatchError,
  createAuthorizationService,
  type AuthorizationDeniedError,
  type AuthorizationCheck,
  type AuthorizationContext,
  type PermissionRule,
  type PermissionRuleStore,
  type RemovePermissionRuleInput,
  type RuleObject,
  type UpsertPermissionRuleInput,
  InvalidAuthorizationInputError,
  validateAuthorizationCheck,
  validateRuleSubject,
} from "../src/index.js";

const timestamp = "2026-07-16T10:00:00.000Z";

const rule = (
  id: string,
  input: Partial<PermissionRule> &
    Pick<PermissionRule, "context" | "subject" | "object" | "permit">,
): PermissionRule => ({
  id,
  verb: "close",
  createdByUserId: "admin-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  ...input,
});

const sameContext = (
  left: AuthorizationContext,
  right: AuthorizationContext,
): boolean =>
  left.guildId === right.guildId &&
  left.categoryId === right.categoryId &&
  left.channelId === right.channelId;

class MemoryRuleStore implements PermissionRuleStore {
  constructor(private readonly rules: PermissionRule[]) {}

  async upsert(input: UpsertPermissionRuleInput): Promise<void> {
    const next: PermissionRule = {
      ...input.rule,
      createdByUserId: input.actor.actorId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const index = this.rules.findIndex((candidate) => candidate.id === next.id);
    if (index === -1) this.rules.push(next);
    else this.rules[index] = next;
  }

  async remove(input: RemovePermissionRuleInput): Promise<void> {
    const index = this.rules.findIndex(
      (candidate) => candidate.id === input.ruleId,
    );
    if (index !== -1) this.rules.splice(index, 1);
  }

  async listForContext(
    context: AuthorizationContext,
  ): Promise<readonly PermissionRule[]> {
    return this.rules.filter((candidate) =>
      sameContext(candidate.context, context),
    );
  }

  async listForObject(input: {
    context: AuthorizationContext;
    object: RuleObject;
  }): Promise<readonly PermissionRule[]> {
    return this.rules.filter(
      (candidate) =>
        sameContext(candidate.context, input.context) &&
        candidate.object.objectType === input.object.objectType &&
        candidate.object.objectId === input.object.objectId,
    );
  }
}

const baseCheck = (overrides: Partial<AuthorizationCheck> = {}) =>
  ({
    context: {
      guildId: "guild-1",
      categoryId: "category-1",
      channelId: "channel-1",
    },
    subject: {
      subjectType: "user",
      subjectId: "user-1",
      attributes: {
        discordRoleIds: ["role-1", "role-2"],
        isGuildOwner: false,
        isAdministrator: false,
        canManageGuild: false,
        isApplicationOperator: false,
      },
    },
    object: { objectType: "ticket", objectId: "ticket-1" },
    verb: "close",
    ...overrides,
  }) satisfies AuthorizationCheck;

const serviceFor = (rules: PermissionRule[], validateResource = () => true) =>
  createAuthorizationService({
    store: new MemoryRuleStore(rules),
    validateResource,
  });

describe("authorization precedence", () => {
  it("prefers channel over category and guild rules", async () => {
    const service = serviceFor([
      rule("guild-allow", {
        context: { guildId: "guild-1" },
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
      rule("category-deny", {
        context: { guildId: "guild-1", categoryId: "category-1" },
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "deny",
      }),
      rule("channel-allow", {
        context: {
          guildId: "guild-1",
          categoryId: "category-1",
          channelId: "channel-1",
        },
        subject: { subjectType: "role", subjectId: "role-1" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "allow",
      }),
    ]);

    await expect(service.check(baseCheck())).resolves.toEqual({
      allowed: true,
      reason: "matched_rule",
      matchedRuleIds: ["channel-allow"],
    });
    await expect(
      service.check(
        baseCheck({
          context: { guildId: "guild-1", categoryId: "category-1" },
        }),
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "matched_rule",
      matchedRuleIds: ["category-deny"],
    });
  });

  it("falls directly from an uncategorized channel to its guild", async () => {
    const service = serviceFor([
      rule("guild-allow", {
        context: { guildId: "guild-1" },
        subject: { subjectType: "everyone", subjectId: "*" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "allow",
      }),
    ]);

    const decision = await service.check(
      baseCheck({
        context: { guildId: "guild-1", channelId: "uncategorized-1" },
      }),
    );
    expect(decision.matchedRuleIds).toEqual(["guild-allow"]);
  });

  it("prefers exact objects, then exact users, roles, and everyone", async () => {
    const service = serviceFor([
      rule("wildcard-user-deny", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "deny",
      }),
      rule("exact-everyone-allow", {
        context: baseCheck().context,
        subject: { subjectType: "everyone", subjectId: "*" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
      rule("exact-role-deny", {
        context: baseCheck().context,
        subject: { subjectType: "role", subjectId: "role-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "deny",
      }),
      rule("exact-user-allow", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
    ]);

    await expect(service.check(baseCheck())).resolves.toMatchObject({
      allowed: true,
      matchedRuleIds: ["exact-user-allow"],
    });
  });

  it("lets deny win across multiple matching roles in one layer", async () => {
    const service = serviceFor([
      rule("role-allow", {
        context: baseCheck().context,
        subject: { subjectType: "role", subjectId: "role-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
      rule("role-deny", {
        context: baseCheck().context,
        subject: { subjectType: "role", subjectId: "role-2" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "deny",
      }),
    ]);

    await expect(service.check(baseCheck())).resolves.toEqual({
      allowed: false,
      reason: "matched_rule",
      matchedRuleIds: ["role-allow", "role-deny"],
    });
  });

  it("matches services only against their exact selector", async () => {
    const service = serviceFor([
      rule("everyone-allow", {
        context: { guildId: "guild-1" },
        subject: { subjectType: "everyone", subjectId: "*" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "allow",
      }),
      rule("service-deny", {
        context: { guildId: "guild-1" },
        subject: { subjectType: "service", subjectId: "prod-ai" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "deny",
      }),
    ]);

    const decision = await service.check(
      baseCheck({
        context: { guildId: "guild-1" },
        subject: { subjectType: "service", subjectId: "prod-ai" },
      }),
    );
    expect(decision.matchedRuleIds).toEqual(["service-deny"]);
  });
});

describe("authorization safety", () => {
  it("rejects forged runtime subjects before they participate in evaluation", async () => {
    const service = serviceFor([
      rule("role-allow", {
        context: {
          guildId: "guild-1",
          categoryId: "category-1",
          channelId: "channel-1",
        },
        subject: { subjectType: "role", subjectId: "role-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
    ]);

    await expect(
      service.check(
        baseCheck({
          subject: {
            subjectType: "role",
            subjectId: "role-1",
            attributes: { discordRoleIds: [] },
          } as unknown as AuthorizationCheck["subject"],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAuthorizationInputError);

    expect(() =>
      validateAuthorizationCheck(
        baseCheck({
          subject: {
            subjectType: "user",
            subjectId: "user-1",
            attributes: {
              discordRoleIds: [],
              isGuildOwner: "false",
              isAdministrator: false,
              canManageGuild: false,
              isApplicationOperator: false,
            },
          } as unknown as AuthorizationCheck["subject"],
        }),
      ),
    ).toThrow("subject.attributes.isGuildOwner must be a boolean");

    expect(() =>
      validateRuleSubject({ subjectType: "group", subjectId: "group-1" }),
    ).toThrow("unsupported rule subject type: group");
  });

  it("rejects wildcard IDs for exact runtime and stored selectors", () => {
    expect(() =>
      validateAuthorizationCheck(
        baseCheck({ subject: { subjectType: "service", subjectId: "*" } }),
      ),
    ).toThrow("service subjects must use an exact subjectId");
    expect(() =>
      validateRuleSubject({ subjectType: "role", subjectId: "*" }),
    ).toThrow("role selectors must use an exact subjectId");
  });

  it.each([
    [
      "guild_owner",
      {
        isGuildOwner: true,
        isAdministrator: false,
        canManageGuild: false,
        isApplicationOperator: false,
      },
    ],
    [
      "administrator",
      {
        isGuildOwner: false,
        isAdministrator: true,
        canManageGuild: true,
        isApplicationOperator: false,
      },
    ],
    [
      "application_operator",
      {
        isGuildOwner: false,
        isAdministrator: false,
        canManageGuild: false,
        isApplicationOperator: true,
      },
    ],
  ] as const)("keeps %s as break-glass", async (reason, attributes) => {
    const service = serviceFor([
      rule("explicit-deny", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "deny",
      }),
    ]);

    await expect(
      service.check(
        baseCheck({
          subject: {
            subjectType: "user",
            subjectId: "user-1",
            attributes: { discordRoleIds: [], ...attributes },
          },
        }),
      ),
    ).resolves.toEqual({ allowed: true, reason, matchedRuleIds: [] });
  });

  it("limits Manage Server authority to guild configuration management", async () => {
    const managedSubject = {
      subjectType: "user" as const,
      subjectId: "user-1",
      attributes: {
        discordRoleIds: [],
        isGuildOwner: false,
        isAdministrator: false,
        canManageGuild: true,
        isApplicationOperator: false,
      },
    };
    const service = serviceFor([
      rule("settings-deny", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "settings", objectId: "*" },
        verb: "manage",
        permit: "deny",
      }),
      rule("permissions-deny", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "permissions", objectId: "*" },
        verb: "manage",
        permit: "deny",
      }),
      rule("ticket-deny", {
        context: baseCheck().context,
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "deny",
      }),
    ]);

    for (const objectType of ["settings", "permissions"] as const) {
      await expect(
        service.check(
          baseCheck({
            subject: managedSubject,
            object: { objectType, objectId: "*" },
            verb: "manage",
          }),
        ),
      ).resolves.toEqual({
        allowed: true,
        reason: "manage_guild",
        matchedRuleIds: [],
      });
    }
    await expect(
      service.check(baseCheck({ subject: managedSubject })),
    ).resolves.toMatchObject({ allowed: false, reason: "matched_rule" });
    await expect(
      service.check(
        baseCheck({
          subject: managedSubject,
          object: { objectType: "queue", objectId: "*" },
          verb: "manage",
        }),
      ),
    ).resolves.toMatchObject({ allowed: false, reason: "default_deny" });
    await expect(
      service.check(
        baseCheck({
          subject: managedSubject,
          object: { objectType: "settings", objectId: "*" },
          verb: "view",
        }),
      ),
    ).resolves.toMatchObject({ allowed: false, reason: "default_deny" });
  });

  it("defaults to deny and require throws the typed decision", async () => {
    const service = serviceFor([]);
    const decision = await service.check(baseCheck());

    expect(decision).toEqual({
      allowed: false,
      reason: "default_deny",
      matchedRuleIds: [],
    });
    await expect(service.require(baseCheck())).rejects.toMatchObject({
      name: "AuthorizationDeniedError",
      decision,
    } satisfies Partial<AuthorizationDeniedError>);
  });

  it("validates the trusted resource before applying break-glass", async () => {
    const service = serviceFor([], () => false);
    await expect(
      service.check(
        baseCheck({
          subject: {
            subjectType: "user",
            subjectId: "owner-1",
            attributes: {
              discordRoleIds: [],
              isGuildOwner: true,
              isAdministrator: true,
              canManageGuild: true,
              isApplicationOperator: true,
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationResourceMismatchError);
  });
});
