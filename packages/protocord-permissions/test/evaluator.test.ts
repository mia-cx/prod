import { describe, expect, it } from "vitest";

import {
  AuthorizationResourceMismatchError,
  createAuthorizationService,
  type AuthorizationDeniedError,
  type AuthorizationCheck,
  type AuthorizationContext,
  type PermissionRule,
  type PermissionRuleStore,
  type RuleObject,
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

  async upsert(next: PermissionRule): Promise<void> {
    const index = this.rules.findIndex((candidate) => candidate.id === next.id);
    if (index === -1) this.rules.push(next);
    else this.rules[index] = next;
  }

  async remove(ruleId: string): Promise<void> {
    const index = this.rules.findIndex((candidate) => candidate.id === ruleId);
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
      },
    },
    object: { objectType: "ticket", objectId: "ticket-1" },
    verb: "close",
    ...overrides,
  }) satisfies AuthorizationCheck;

const serviceFor = (
  rules: PermissionRule[],
  validateResource = () => true,
) =>
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
      rule("category-allow", {
        context: { guildId: "guild-1", categoryId: "category-1" },
        subject: { subjectType: "user", subjectId: "user-1" },
        object: { objectType: "ticket", objectId: "ticket-1" },
        permit: "allow",
      }),
      rule("channel-deny", {
        context: {
          guildId: "guild-1",
          categoryId: "category-1",
          channelId: "channel-1",
        },
        subject: { subjectType: "role", subjectId: "role-1" },
        object: { objectType: "ticket", objectId: "*" },
        permit: "deny",
      }),
    ]);

    await expect(service.check(baseCheck())).resolves.toEqual({
      allowed: false,
      reason: "matched_rule",
      matchedRuleIds: ["channel-deny"],
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
    ["guild_owner", { isGuildOwner: true, isAdministrator: false }],
    ["administrator", { isGuildOwner: false, isAdministrator: true }],
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
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationResourceMismatchError);
  });
});
