import {
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createProdActionRuntime } from "../src/actions/runtime.js";
import { createLogger } from "../src/logger.js";

const pingInteraction = (): ChatInputCommandInteraction => {
  const interaction: Record<string, unknown> = {
    commandName: "ping",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "reporter", globalName: "Reporter" },
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
};

describe("Prod action runtime", () => {
  it("registers only /ping and replies with pong", async () => {
    const runtime = createProdActionRuntime(createLogger({ level: "fatal" }));
    const interaction = pingInteraction();

    expect(runtime.actionCount).toBe(1);
    expect(runtime.commands).toEqual([
      {
        type: ApplicationCommandType.ChatInput,
        name: "ping",
        description: "Check whether Prod is responsive",
        options: [],
      },
    ]);

    await runtime.handleInteraction(interaction as unknown as Interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({});
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "pong!" });
  });
});
