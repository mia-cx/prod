import { describe, expect, it, vi } from "vitest";

import {
  createProdAuthorizationContext,
  createProdAuthorizationService,
  createProdPermissionRuleStore,
  UnsupportedProdAuthorizationContextError,
} from "../src/authorization.js";
import type {
  AuthorizationCheck,
  PermissionRule,
  PermissionRuleStore,
} from "@protocord/permissions";

const timestamp = "2026-07-16T10:00:00.000Z";

const rule = (context: PermissionRule["context"]): PermissionRule => ({
  id: "rule-1",
  context,
  subject: { subjectType: "role", subjectId: "role-1" },
  object: { objectType: "ticket", objectId: "*" },
  verb: "close",
  permit: "allow",
  createdByUserId: "admin-1",
  createdAt: timestamp,
  updatedAt: timestamp,
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
    const store = createProdPermissionRuleStore(backingStore());

    await expect(store.upsert(rule(context))).rejects.toBeInstanceOf(
      UnsupportedProdAuthorizationContextError,
    );
    await expect(store.listForContext(context)).rejects.toBeInstanceOf(
      UnsupportedProdAuthorizationContextError,
    );
  });

  it("passes guild-level administration to the package store", async () => {
    const backing = backingStore();
    const store = createProdPermissionRuleStore(backing);
    const guildRule = rule({ guildId: "guild-1" });

    await store.upsert(guildRule);
    await store.listForObject({
      context: guildRule.context,
      object: guildRule.object,
    });
    await store.remove(guildRule.id);

    expect(backing.upsert).toHaveBeenCalledWith(guildRule);
    expect(backing.listForObject).toHaveBeenCalledOnce();
    expect(backing.remove).toHaveBeenCalledWith(guildRule.id);
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
});
