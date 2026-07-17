import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";

import {
  guildSettings,
  labels,
  permissionRuleOrigins,
  permissionRuleEvents,
  permissionRules,
  reporterHubAccess,
  schemaContributors,
  ticketEvents,
  ticketLabels,
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
    expect(getTableName(reporterHubAccess)).toBe("reporter_hub_access");
    expect(getTableName(permissionRuleOrigins)).toBe(
      "permission_rule_origins",
    );
  });

  it("includes the app-owned label taxonomy tables", () => {
    expect(getTableName(labels)).toBe("labels");
    expect(getTableName(ticketLabels)).toBe("ticket_labels");
  });
});
