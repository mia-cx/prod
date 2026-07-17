import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";

import {
  guildSettings,
  permissionRuleEvents,
  permissionRules,
  schemaContributors,
  ticketEvents,
  tickets,
} from "../src/schema.js";

describe("Drizzle schema composition", () => {
  it("is selected explicitly by the deployable application", () => {
    expect(schemaContributors).toEqual([
      "@protocord/permissions",
      "@mia-cx/protocord-model-settings",
      "@prod/app",
    ]);
  });

  it("composes package-prefixed permission tables", () => {
    expect(getTableName(permissionRules)).toBe("protocord_permission_rules");
    expect(getTableName(permissionRuleEvents)).toBe(
      "protocord_permission_rule_events",
    );
  });

  it("includes the app-owned guild settings table", () => {
    expect(getTableName(guildSettings)).toBe("guild_settings");
    expect(getTableName(tickets)).toBe("tickets");
    expect(getTableName(ticketEvents)).toBe("ticket_events");
  });
});
