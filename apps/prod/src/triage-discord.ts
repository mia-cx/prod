import { createDiscordUserSubject } from "@protocord/permissions";
import type { TriageDiscordPort } from "./triage.js";

export const createTriageDiscord = (
  options: Readonly<{
    isApplicationOperator: (userId: string) => boolean;
  }>,
): TriageDiscordPort => ({
  recentMessages: async (message) => {
    const recent = await message.channel.messages.fetch({
      limit: 50,
      before: message.id,
    });
    return [...recent.values()].reverse().map((entry) => ({
      id: entry.id,
      authorId: entry.author.id,
      content: entry.content,
      isAssistant:
        entry.author.id === message.client.user.id && !entry.webhookId,
    }));
  },
  candidates: async (message) => {
    if (!message.guild) return [];
    const subjects = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const members = await message.guild.members.list({
        limit: 1000,
        ...(after === undefined ? {} : { after }),
      });
      for (const member of members.values()) {
        if (!member.user.bot)
          subjects.push(
            createDiscordUserSubject(
              member,
              { guildId: message.guild.id },
              { isApplicationOperator: options.isApplicationOperator },
            ),
          );
      }
      if (members.size < 1000) break;
      after = members.lastKey();
    }
    return subjects;
  },
  post: async (message, content) => {
    if (!message.channel.isThread())
      throw new Error("Triage requires a ticket thread");
    await message.channel.send({ content, allowedMentions: { parse: [] } });
  },
});
