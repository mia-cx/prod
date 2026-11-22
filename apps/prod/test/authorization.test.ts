import { describe, expect, it, vi } from "vitest";

import {
  createProdAuthorizationContext,
  createProdAuthorizationResourceValidator,
  createProdAuthorizationService,
  createProdPermissionRuleStore,
  UnsupportedProdAuthorizationContextError,
} from "../src/authorization.js";
import type {
  AuthorizationCheck,
  PermissionRuleActor,
  PermissionRuleInput,
  PermissionRuleStore,
} from "@protocord/permissions";

const rule = (
  context: PermissionRuleInput["context"],
): PermissionRuleInput => ({
  id: "rule-1",
  context,
  subject: { subjectType: "role", subjectId: "role-1" },
  object: { objectType: "ticket", objectId: "*" },
  verb: "close",
  permit: "allow",
});

const actor = (actorId: string): PermissionRuleActor => ({
  actorType: "user",
  actorId,
});

const backingStore = (): PermissionRuleStore => ({
  upsert: vi.fn(),
  remove: vi.fn(),
  listForContext: vi.fn().mockResolvedValue([]),
  listForObject: vi.fn().mockResolvedValue([]),
});

const check = (context: AuthorizationCheck["context"]): AuthorizationCheck => ({
  context,
  subject: { subjectType: "service", subjectId: "prod-ai" },
  object: { objectType: "ticket", objectId: "ticket-1" },
  verb: "close",
});

describe("Prod authorization policy boundary", () => {
  it("accepts only ticket resources belonging to the authorization guild", async () => {
    const validate = createProdAuthorizationResourceValidator({
      get: async (ticketId) =>
        ticketId === "ticket-1"
          ? ({ id: ticketId, guildId: "guild-1" } as never)
          : undefined,
    });
    await expect(
      validate({
        context: createProdAuthorizationContext("guild-1"),
        object: { objectType: "ticket", objectId: "ticket-1" },
      }),
    ).resolves.toBe(true);
    await expect(
      validate({
        context: createProdAuthorizationContext("guild-2"),
        object: { objectType: "ticket", objectId: "ticket-1" },
      }),
    ).resolves.toBe(false);
    await expect(
      validate({
        context: createProdAuthorizationContext("guild-1"),
        object: { objectType: "ticket", objectId: "missing" },
      }),
    ).resolves.toBe(false);
    for (const objectType of ["settings", "permissions"] as const) {
      await expect(
        validate({
          context: createProdAuthorizationContext("guild-1"),
          object: { objectType, objectId: "*" },
        }),
      ).resolves.toBe(true);
      await expect(
        validate({
          context: createProdAuthorizationContext("guild-1"),
          object: { objectType, objectId: "specific" } as never,
        }),
      ).resolves.toBe(false);
    }
  });
  it("constructs only a guild-level context", () => {
    expect(createProdAuthorizationContext("guild-1")).toEqual({
      guildId: "guild-1",
    });
    expect(() => createProdAuthorizationContext("")).toThrow(
      "guildId must not be empty",
    );
  });

  it.each([
    { guildId: "guild-1", categoryId: "category-1" },
    { guildId: "guild-1", channelId: "channel-1" },
    {
      guildId: "guild-1",
      categoryId: "category-1",
      channelId: "channel-1",
    },
  ])("refuses to administer refined rule context $context", async (context) => {
    const backing = backingStore();
    const store = createProdPermissionRuleStore(backing);
    const refinedRule = rule(context);

    await expect(
      store.upsert({
        context,
        rule: refinedRule,
        actor: actor("admin-1"),
      }),
    ).rejects.toBeInstanceOf(UnsupportedProdAuthorizationContextError);
    await expect(
      store.remove({
        ruleId: refinedRule.id,
        context,
        actor: actor("admin-1"),
      }),
    ).rejects.toBeInstanceOf(UnsupportedProdAuthorizationContextError);
    await expect(store.listForContext(context)).rejects.toBeInstanceOf(
      UnsupportedProdAuthorizationContextError,
    );
    expect(backing.upsert).not.toHaveBeenCalled();
    expect(backing.remove).not.toHaveBeenCalled();
  });

  it("passes guild-level administration to the package store", async () => {
    const backing = backingStore();
    const store = createProdPermissionRuleStore(backing);
    const guildRule = rule({ guildId: "guild-1" });

    const upsertInput = {
      context: guildRule.context,
      rule: guildRule,
      actor: actor("admin-1"),
    };
    const removeInput = {
      ruleId: guildRule.id,
      context: guildRule.context,
      actor: actor("admin-2"),
    };
    await store.upsert(upsertInput);
    await store.listForObject({
      context: guildRule.context,
      object: guildRule.object,
    });
    await store.remove(removeInput);

    expect(backing.upsert).toHaveBeenCalledWith(upsertInput);
    expect(backing.listForObject).toHaveBeenCalledOnce();
    expect(backing.remove).toHaveBeenCalledWith(removeInput);
  });

  it("refuses to evaluate refined contexts before resource lookup", async () => {
    const validateResource = vi.fn(() => true);
    const service = createProdAuthorizationService({
      store: backingStore(),
      validateResource,
    });

    await expect(
      service.check(
        check({
          guildId: "guild-1",
          categoryId: "category-1",
          channelId: "channel-1",
        }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedProdAuthorizationContextError);
    expect(validateResource).not.toHaveBeenCalled();
  });

  it("retains package default-deny behavior for guild checks", async () => {
    const service = createProdAuthorizationService({
      store: backingStore(),
      validateResource: () => true,
    });

    await expect(
      service.check(check(createProdAuthorizationContext("guild-1"))),
    ).resolves.toEqual({
      allowed: false,
      reason: "default_deny",
      matchedRuleIds: [],
    });
  });

  it("grants prod-ai exactly its four built-in ticket permissions", async () => {
    const service = createProdAuthorizationService({
      store: backingStore(),
      validateResource: () => true,
    });
    for (const verb of [
      "view_metadata",
      "complete_triage",
      "label",
      "suggest_assignee",
    ] as const) {
      const input = { ...check({ guildId: "guild-1" }), verb };
      await expect(service.check(input)).resolves.toMatchObject({
        allowed: true,
        matchedRuleIds: [`prod:default:prod-ai:${verb}`],
      });
      await expect(service.require(input)).resolves.toBeUndefined();
    }
    for (const verb of [
      "claim_self",
      "unclaim_self",
      "assign_other",
      "unassign_other",
      "pause_triage",
      "resume_triage",
      "close",
      "reopen",
      "view",
      "manage",
    ] as const) {
      await expect(
        service.check({ ...check({ guildId: "guild-1" }), verb }),
      ).resolves.toMatchObject({ allowed: false });
    }
    await expect(
      service.check({
        ...check({ guildId: "guild-1" }),
        verb: "view_metadata",
        subject: { subjectType: "service", subjectId: "other" },
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.check({
        ...check({ guildId: "guild-1" }),
        verb: "view_metadata",
        object: { objectType: "settings", objectId: "*" },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("does not bypass resource validation for default service grants", async () => {
    const service = createProdAuthorizationService({
      store: backingStore(),
      validateResource: () => false,
    });
    await expect(
      service.check({
        ...check({ guildId: "guild-1" }),
        verb: "view_metadata",
      }),
    ).rejects.toThrow("Authorization object does not belong");
  });
});
