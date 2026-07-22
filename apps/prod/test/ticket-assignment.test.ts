import { describe, expect, it, vi } from "vitest";
import {
  createAuthorizationService,
  createDiscordUserSubject,
  createSqlitePermissionRuleStore,
  type AuthorizationDecision,
  type AuthorizationService,
  type DiscordMemberLike,
  type PermissionVerb,
} from "@protocord/permissions";

import { openDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrations.js";
import {
  createProdAuthorizationContext,
  createProdAuthorizationResourceValidator,
} from "../src/authorization.js";
import { createTicketAssignmentService } from "../src/ticket-assignment.js";
import {
  createSqliteTicketStore,
  TicketAssignmentStateError,
  type TicketStore,
} from "../src/tickets.js";

const member = (id: string, guildId = "guild-1"): DiscordMemberLike => ({
  id,
  guild: { id: guildId, ownerId: "owner-1" },
  roles: { cache: new Map<string, Readonly<{ id: string }>>() },
  permissions: { has: () => false },
});

const authorizationFor = (
  ...allowed: readonly `${string}:${PermissionVerb}`[]
): AuthorizationService => {
  const allowedChecks = new Set<string>(allowed);
  const decide = (
    subjectId: string,
    verb: PermissionVerb,
  ): AuthorizationDecision => {
    const allowed = allowedChecks.has(`${subjectId}:${verb}`);
    return {
      allowed,
      reason: allowed ? "matched_rule" : "default_deny",
      matchedRuleIds: allowed ? ["rule-1"] : [],
    };
  };
  const authorization: AuthorizationService = {
    check: async ({ subject, verb }) => decide(subject.subjectId, verb),
    require: async ({ subject, verb }) => {
      if (!decide(subject.subjectId, verb).allowed) {
        throw new Error("Authorization denied");
      }
    },
  };
  return Object.freeze(authorization);
};

const createOpenTicket = async (store: TicketStore, id = "ticket-1") => {
  const ticket = await store.create({
    id,
    guildId: "guild-1",
    hubChannelId: "hub-1",
    reporterUserId: `reporter-${id}`,
    originatingAlias: "issue",
  });
  await store.recordProgress(
    ticket.id,
    "thread_created",
    {},
    { threadId: `thread-${id}` },
  );
  await store.recordProgress(
    ticket.id,
    "instructions_posted",
    {},
    { openingMessageId: `message-${id}` },
  );
  await store.markOpen(ticket.id);
  const opened = await store.get(ticket.id);
  if (opened === undefined) throw new Error("Opened ticket was not persisted");
  return opened;
};

describe("ticket assignment service", () => {
  it("composes persisted role rules with the production ticket resource check", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    const rules = createSqlitePermissionRuleStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const context = createProdAuthorizationContext("guild-1");
      for (const [id, verb] of [
        ["assign-rule", "assign_other"],
        ["claim-rule", "claim_self"],
      ] as const) {
        await rules.upsert({
          context,
          rule: {
            id,
            context,
            subject: { subjectType: "role", subjectId: "staff-role" },
            object: { objectType: "ticket", objectId: "*" },
            verb,
            permit: "allow",
          },
          actor: { actorType: "user", actorId: "admin-1" },
        });
      }
      const authorization = createAuthorizationService({
        store: rules,
        validateResource: createProdAuthorizationResourceValidator(tickets),
      });
      const withStaffRole = (id: string): DiscordMemberLike => ({
        ...member(id),
        roles: {
          cache: new Map([["staff-role", { id: "staff-role" }]]),
        },
      });
      const service = createTicketAssignmentService({
        tickets,
        authorization,
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.assign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: withStaffRole("actor-1"),
          target: withStaffRole("target-1"),
        }),
      ).resolves.toMatchObject({ added: true, assigneeCount: 1 });
      await expect(tickets.listAssignees(ticket.id)).resolves.toMatchObject([
        { assigneeUserId: "target-1", assignedByUserId: "actor-1" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("authorizes a claim against the exact guild and ticket resource", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const check = vi.fn(async () => ({
        allowed: true,
        reason: "matched_rule" as const,
        matchedRuleIds: ["rule-1"],
      }));
      const service = createTicketAssignmentService({
        tickets,
        authorization: { check, require: async () => undefined },
        createUserAuthorizationSubject: createDiscordUserSubject,
      });
      await service.claim({
        guildId: "guild-1",
        threadId: "thread-ticket-1",
        actor: member("user-1"),
      });
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { guildId: "guild-1" },
          object: { objectType: "ticket", objectId: ticket.id },
          verb: "claim_self",
        }),
      );
    } finally {
      connection.close();
    }
  });
  it("persists a self claim and pauses triage on the first assignee", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const actor = member("user-1");
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("user-1:claim_self"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.claim({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor,
        }),
      ).resolves.toEqual({
        ticket,
        added: true,
        assigneeCount: 1,
        triagePaused: true,
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toMatchObject([
        {
          assigneeUserId: "user-1",
          assignedByUserId: "user-1",
          method: "self_claim",
        },
      ]);
      await expect(tickets.get(ticket.id)).resolves.toMatchObject({
        triageStatus: "paused",
      });
    } finally {
      connection.close();
    }
  });

  it("rejects a self claim without claim permission and makes no change", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor(),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.claim({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("user-1"),
        }),
      ).rejects.toMatchObject({
        name: "TicketAssignmentError",
        code: "unauthorized",
        message: "You do not have permission to claim this ticket.",
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toEqual([]);
      expect(
        (await tickets.listEvents(ticket.id)).filter(
          ({ eventType }) => eventType === "assignee_added",
        ),
      ).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("unclaims only the actor and preserves other assignees", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      for (const assigneeUserId of ["user-1", "user-2"]) {
        await tickets.addAssignee({
          ticketId: ticket.id,
          assigneeUserId,
          assignedByUserId: assigneeUserId,
          method: "self_claim",
        });
      }
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("user-1:unclaim_self"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.unclaim({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("user-1"),
        }),
      ).resolves.toMatchObject({
        ticket: { id: ticket.id, triageStatus: "paused" },
        removed: true,
        assigneeCount: 1,
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toMatchObject([
        { assigneeUserId: "user-2" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("rejects an unclaim without permission and preserves assignment history", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      await tickets.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "user-1",
        assignedByUserId: "user-1",
        method: "self_claim",
      });
      const beforeEvents = await tickets.listEvents(ticket.id);
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor(),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.unclaim({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("user-1"),
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(tickets.listAssignees(ticket.id)).resolves.toHaveLength(1);
      await expect(tickets.listEvents(ticket.id)).resolves.toEqual(
        beforeEvents,
      );
    } finally {
      connection.close();
    }
  });

  it("does not accept claim_self as delegated assignment permission", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor(
          "actor-1:claim_self",
          "target-1:claim_self",
        ),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.assign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("target-1"),
        }),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message:
          "You do not have delegated assignment permission for this ticket.",
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("rejects a delegated assignment when the target cannot self-claim", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("actor-1:assign_other"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.assign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("target-1"),
        }),
      ).rejects.toMatchObject({
        code: "target_ineligible",
        message: "That member is not eligible to be assigned to this ticket.",
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("persists delegated assignment provenance for an eligible target", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor(
          "actor-1:assign_other",
          "target-1:claim_self",
        ),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.assign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("target-1"),
        }),
      ).resolves.toEqual({
        ticket,
        added: true,
        assigneeCount: 1,
        triagePaused: true,
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toMatchObject([
        {
          assigneeUserId: "target-1",
          assignedByUserId: "actor-1",
          method: "delegated",
        },
      ]);
    } finally {
      connection.close();
    }
  });

  it("requires delegated unassignment permission", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      await tickets.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "target-1",
        assignedByUserId: "actor-1",
        method: "delegated",
      });
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("actor-1:unclaim_self"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.unassign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("target-1"),
        }),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message:
          "You do not have delegated assignment permission for this ticket.",
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("unassigns the chosen target without an eligibility check", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      for (const assigneeUserId of ["target-1", "target-2"]) {
        await tickets.addAssignee({
          ticketId: ticket.id,
          assigneeUserId,
          assignedByUserId: "actor-1",
          method: "delegated",
        });
      }
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("actor-1:unassign_other"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.unassign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("target-1"),
        }),
      ).resolves.toMatchObject({
        ticket: { id: ticket.id },
        removed: true,
        assigneeCount: 1,
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toMatchObject([
        { assigneeUserId: "target-2" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("does not let delegated unassignment bypass self-unclaim permission", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const ticket = await createOpenTicket(tickets);
      await tickets.addAssignee({
        ticketId: ticket.id,
        assigneeUserId: "actor-1",
        assignedByUserId: "actor-1",
        method: "self_claim",
      });
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("actor-1:unassign_other"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.unassign({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
          target: member("actor-1"),
        }),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message: "You do not have permission to unclaim this ticket.",
      });
      await expect(tickets.listAssignees(ticket.id)).resolves.toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("maps a ticket closing between lookup and mutation to the thread error", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      await createOpenTicket(tickets);
      const racingTickets: TicketStore = {
        ...tickets,
        addAssignee: async () => {
          throw new TicketAssignmentStateError();
        },
      };
      const service = createTicketAssignmentService({
        tickets: racingTickets,
        authorization: authorizationFor("actor-1:claim_self"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });

      await expect(
        service.claim({
          guildId: "guild-1",
          threadId: "thread-ticket-1",
          actor: member("actor-1"),
        }),
      ).rejects.toMatchObject({
        code: "not_a_ticket_thread",
        message:
          "This command can only be used in an open ticket thread for this server.",
      });
    } finally {
      connection.close();
    }
  });

  it.each(["claim", "assign"] as const)(
    "reports a duplicate %s as an idempotent no-op without another event",
    async (operation) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      const tickets = createSqliteTicketStore(connection.database);
      try {
        const ticket = await createOpenTicket(tickets);
        const service = createTicketAssignmentService({
          tickets,
          authorization: authorizationFor(
            "actor-1:claim_self",
            "actor-1:assign_other",
            "target-1:claim_self",
          ),
          createUserAuthorizationSubject: createDiscordUserSubject,
        });

        const mutate = () =>
          operation === "claim"
            ? service.claim({
                guildId: "guild-1",
                threadId: "thread-ticket-1",
                actor: member("actor-1"),
              })
            : service.assign({
                guildId: "guild-1",
                threadId: "thread-ticket-1",
                actor: member("actor-1"),
                target: member("target-1"),
              });
        await mutate();

        await expect(mutate()).resolves.toMatchObject({
          ticket: { id: ticket.id },
          added: false,
          assigneeCount: 1,
          triagePaused: false,
        });
        expect(
          (await tickets.listEvents(ticket.id)).filter(
            ({ eventType }) => eventType === "assignee_added",
          ),
        ).toHaveLength(1);
      } finally {
        connection.close();
      }
    },
  );

  it.each(["unclaim", "unassign"] as const)(
    "reports a duplicate %s as an idempotent no-op and leaves triage paused",
    async (operation) => {
      const connection = openDatabase(":memory:");
      await applyMigrations(connection.database);
      const tickets = createSqliteTicketStore(connection.database);
      try {
        const ticket = await createOpenTicket(tickets);
        const assigneeUserId = operation === "unclaim" ? "actor-1" : "target-1";
        await tickets.addAssignee({
          ticketId: ticket.id,
          assigneeUserId,
          assignedByUserId: "actor-1",
          method: operation === "unclaim" ? "self_claim" : "delegated",
        });
        const service = createTicketAssignmentService({
          tickets,
          authorization: authorizationFor(
            "actor-1:unclaim_self",
            "actor-1:unassign_other",
          ),
          createUserAuthorizationSubject: createDiscordUserSubject,
        });

        const mutate = () =>
          operation === "unclaim"
            ? service.unclaim({
                guildId: "guild-1",
                threadId: "thread-ticket-1",
                actor: member("actor-1"),
              })
            : service.unassign({
                guildId: "guild-1",
                threadId: "thread-ticket-1",
                actor: member("actor-1"),
                target: member("target-1"),
              });
        await mutate();

        await expect(mutate()).resolves.toMatchObject({
          ticket: { id: ticket.id },
          removed: false,
          assigneeCount: 0,
        });
        expect(
          (await tickets.listEvents(ticket.id)).filter(
            ({ eventType }) => eventType === "assignee_removed",
          ),
        ).toHaveLength(1);
        await expect(tickets.get(ticket.id)).resolves.toMatchObject({
          triageStatus: "paused",
        });
      } finally {
        connection.close();
      }
    },
  );

  it("rejects commands outside a known open ticket thread in the guild", async () => {
    const connection = openDatabase(":memory:");
    await applyMigrations(connection.database);
    const tickets = createSqliteTicketStore(connection.database);
    try {
      const openTicket = await createOpenTicket(tickets, "ticket-open");
      const provisioningTicket = await tickets.create({
        id: "ticket-provisioning",
        guildId: "guild-1",
        hubChannelId: "hub-1",
        reporterUserId: "reporter-provisioning",
        originatingAlias: "issue",
      });
      await tickets.recordProgress(
        provisioningTicket.id,
        "thread_created",
        {},
        { threadId: "thread-provisioning" },
      );
      const service = createTicketAssignmentService({
        tickets,
        authorization: authorizationFor("actor-1:claim_self"),
        createUserAuthorizationSubject: createDiscordUserSubject,
      });
      const cases = [
        { guildId: "guild-1", threadId: "thread-missing" },
        { guildId: "guild-1", threadId: "thread-provisioning" },
        { guildId: "guild-2", threadId: "thread-ticket-open" },
      ];

      for (const input of cases) {
        await expect(
          service.claim({ ...input, actor: member("actor-1", input.guildId) }),
        ).rejects.toMatchObject({
          code: "not_a_ticket_thread",
          message:
            "This command can only be used in an open ticket thread for this server.",
        });
      }
      await expect(tickets.listAssignees(openTicket.id)).resolves.toEqual([]);
      await expect(
        tickets.listAssignees(provisioningTicket.id),
      ).resolves.toEqual([]);
    } finally {
      connection.close();
    }
  });
});
