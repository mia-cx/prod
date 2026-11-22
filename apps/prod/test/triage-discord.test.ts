import { Collection } from "discord.js";
import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createTriageDiscord } from "../src/triage-discord.js";

const discord = () =>
  createTriageDiscord({ isApplicationOperator: () => false });

describe("triage Discord port", () => {
  it("reads history before the triggering message and identifies only this bot as assistant", async () => {
    const entries = [
      {
        id: "3",
        author: { id: "prod" },
        content: "webhook",
        webhookId: "hook",
      },
      {
        id: "2",
        author: { id: "other-bot" },
        content: "other",
        webhookId: null,
      },
      { id: "1", author: { id: "prod" }, content: "question", webhookId: null },
    ];
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Collection(entries.map((entry) => [entry.id, entry])),
      );
    const input = {
      id: "4",
      channel: { messages: { fetch } },
      client: { user: { id: "prod" } },
    } as unknown as Message;
    expect(await discord().recentMessages(input)).toEqual([
      { id: "1", authorId: "prod", content: "question", isAssistant: true },
      { id: "2", authorId: "other-bot", content: "other", isAssistant: false },
      { id: "3", authorId: "prod", content: "webhook", isAssistant: false },
    ]);
    expect(fetch).toHaveBeenCalledWith({ limit: 50, before: "4" });
  });

  it("sends only to threads with mentions disabled", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const input = {
      channel: { isThread: () => true, send },
    } as unknown as Message;
    await discord().post(input, "question?");
    expect(send).toHaveBeenCalledWith({
      content: "question?",
      allowedMentions: { parse: [] },
    });
    await expect(
      discord().post(
        { channel: { isThread: () => false } } as unknown as Message,
        "question?",
      ),
    ).rejects.toThrow("Triage requires a ticket thread");
  });

  it("returns no candidates outside guilds or for empty membership", async () => {
    expect(await discord().candidates({ guild: null } as Message)).toEqual([]);
    const list = vi.fn().mockResolvedValue(new Collection());
    expect(
      await discord().candidates({
        guild: { id: "guild-1", members: { list } },
      } as unknown as Message),
    ).toEqual([]);
    expect(list).toHaveBeenCalledWith({ limit: 1000 });
  });

  it("paginates membership, excludes bots and builds current Discord authorization subjects", async () => {
    const guild = { id: "guild-1", ownerId: "owner" };
    const member = (id: string, bot: boolean) => ({
      id,
      guild,
      user: { bot },
      roles: { cache: new Collection([["support", { id: "support" }]]) },
      permissions: { has: () => false },
    });
    const first = new Collection(
      Array.from({ length: 1000 }, (_, index) => {
        const id = String(index);
        return [id, member(id, index !== 0)] as const;
      }),
    );
    const list = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Collection([["last", member("last", false)]]));
    const subjects = await discord().candidates({
      guild: { ...guild, members: { list } },
    } as unknown as Message);
    expect(subjects.map((subject) => subject.subjectId)).toEqual(["0", "last"]);
    expect(subjects[0]?.attributes.discordRoleIds).toEqual(["support"]);
    expect(list).toHaveBeenLastCalledWith({ limit: 1000, after: "999" });
  });
});
