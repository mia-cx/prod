import {
  ChannelType,
  Collection,
  MessageFlags,
  type Interaction,
  type RepliableInteraction,
} from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSettingsRuntime,
  encodeSettingsCustomId,
  type SettingsChannel,
  type SettingsDefinition,
  type SettingsMentionable,
  type SettingsRouteAction,
} from "../src/index.js";

type Context = Readonly<{ userId: string }>;

const state = {
  authorized: true,
  count: 0,
  mode: "friendly",
  mentionables: [] as readonly SettingsMentionable[],
  channels: [] as readonly SettingsChannel[],
  name: "Prod",
};
const authorize = vi.fn(() => state.authorized);
const mutateMentionables = vi.fn((values: readonly SettingsMentionable[]) => {
  state.mentionables = values;
});
const mutateChannels = vi.fn((values: readonly SettingsChannel[]) => {
  state.channels = values;
});
const mutateName = vi.fn((values: Readonly<Record<string, string>>) => {
  state.name = values.name ?? state.name;
});

const definition: SettingsDefinition<Context> = {
  title: "Synthetic settings",
  categories: [
    {
      id: "setup",
      label: "Setup",
      authorize,
      subcategories: [
        {
          id: "general",
          label: "General",
          fields: [
            {
              kind: "button",
              id: "increment",
              label: "Increment",
              load: () => ({ value: String(state.count) }),
              mutate: () => {
                state.count += 1;
              },
            },
            {
              kind: "string-select",
              id: "mode",
              label: "Mode",
              load: () => ({
                value: state.mode,
                selectedValues: [state.mode],
                options: [
                  { label: "Friendly", value: "friendly" },
                  { label: "Direct", value: "direct" },
                ],
              }),
              mutate: (values) => {
                state.mode = values[0] ?? state.mode;
              },
            },
            {
              kind: "mentionable-select",
              id: "staff",
              label: "Staff",
              load: () => ({ value: `${String(state.mentionables.length)} selected` }),
              mutate: mutateMentionables,
            },
            {
              kind: "channel-select",
              id: "hub",
              label: "Hub",
              load: () => ({ value: state.channels[0]?.channel.name ?? "None" }),
              mutate: mutateChannels,
            },
            {
              kind: "modal",
              id: "identity",
              label: "Identity",
              title: "Edit identity",
              inputs: [{ id: "name", label: "Name", minLength: 2 }],
              load: () => ({ value: state.name, values: { name: state.name } }),
              validate: (values) =>
                (values.name?.length ?? 0) < 2
                  ? [{ inputId: "name", message: "Use at least two characters." }]
                  : [],
              mutate: mutateName,
            },
          ],
        },
      ],
    },
  ],
};

const runtime = createSettingsRuntime({ definition });

type MockInteraction = Readonly<{
  interaction: Interaction;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  showModal: ReturnType<typeof vi.fn>;
}>;

function route(action: SettingsRouteAction, fieldId?: string): string {
  return encodeSettingsCustomId({
    action,
    categoryId: "setup",
    subcategoryId: "general",
    ...(fieldId === undefined ? {} : { fieldId }),
    page: 0,
  });
}

function mockInteraction(
  kind: "button" | "string" | "mentionable" | "channel" | "modal",
  customId: string,
  extra: Readonly<Record<string, unknown>> = {},
): MockInteraction {
  const reply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const showModal = vi.fn(async () => undefined);
  const interaction = {
    customId,
    user: { id: "admin" },
    replied: false,
    deferred: false,
    reply,
    followUp,
    update,
    showModal,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isMentionableSelectMenu: () => kind === "mentionable",
    isChannelSelectMenu: () => kind === "channel",
    isModalSubmit: () => kind === "modal",
    isFromMessage: () => kind === "modal",
    ...extra,
  } as unknown as Interaction;
  return { interaction, reply, followUp, update, showModal };
}

function mockCommand(): {
  interaction: RepliableInteraction;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  return {
    interaction: {
      replied: false,
      deferred: false,
      reply,
      followUp: vi.fn(async () => undefined),
    } as unknown as RepliableInteraction,
    reply,
  };
}

describe("Discord settings runtime", () => {
  beforeEach(() => {
    state.authorized = true;
    state.count = 0;
    state.mode = "friendly";
    state.mentionables = [];
    state.channels = [];
    state.name = "Prod";
    authorize.mockClear();
    mutateMentionables.mockClear();
    mutateChannels.mockClear();
    mutateName.mockClear();
  });

  it("opens a freshly authorized ephemeral Components v2 view", async () => {
    const command = mockCommand();

    await expect(
      runtime.open(command.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "opened" });

    expect(authorize).toHaveBeenCalledOnce();
    expect(command.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
        components: expect.any(Array),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
  });

  it("rechecks authorization, mutates a button, and rerenders", async () => {
    const button = mockInteraction("button", route("button", "increment"));

    expect(runtime.matches(button.interaction)).toBe(true);
    await expect(
      runtime.handle(button.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });

    expect(state.count).toBe(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(button.update).toHaveBeenCalledOnce();
    expect(JSON.stringify(button.update.mock.calls[0]?.[0])).toContain(
      "Increment updated.",
    );
  });

  it("validates selected options and rerenders their new values", async () => {
    const select = mockInteraction("string", route("string-select", "mode"), {
      values: ["direct"],
    });

    await expect(
      runtime.handle(select.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });

    expect(state.mode).toBe("direct");
    expect(JSON.stringify(select.update.mock.calls[0]?.[0])).toContain("direct");
  });

  it("resolves mixed mentionables into explicit user and role variants", async () => {
    const users = new Collection<string, never>();
    users.set(
      "user-1",
      {
        id: "user-1",
        username: "mia",
        globalName: "Mia",
      } as never,
    );
    const roles = new Collection<string, never>();
    roles.set("role-1", { id: "role-1", name: "Support" } as never);
    const mentionable = mockInteraction(
      "mentionable",
      route("mentionable-select", "staff"),
      { values: ["user-1", "role-1"], users, roles },
    );

    await expect(
      runtime.handle(mentionable.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });

    expect(mutateMentionables).toHaveBeenCalledWith(
      [
        {
          kind: "user",
          id: "user-1",
          user: { id: "user-1", username: "mia", globalName: "Mia" },
        },
        {
          kind: "role",
          id: "role-1",
          role: { id: "role-1", name: "Support" },
        },
      ],
      { userId: "admin" },
    );
  });

  it("resolves channel selections before consumer mutation", async () => {
    const channels = new Collection<string, never>();
    channels.set(
      "channel-1",
      {
        id: "channel-1",
        name: "support-hub",
        type: ChannelType.GuildText,
      } as never,
    );
    const channel = mockInteraction(
      "channel",
      route("channel-select", "hub"),
      { values: ["channel-1"], channels },
    );

    await runtime.handle(channel.interaction, { userId: "admin" });

    expect(mutateChannels).toHaveBeenCalledWith(
      [
        {
          id: "channel-1",
          channel: {
            id: "channel-1",
            name: "support-hub",
            type: ChannelType.GuildText,
          },
        },
      ],
      { userId: "admin" },
    );
  });

  it("preserves invalid modal drafts for an actionable retry", async () => {
    const open = mockInteraction("button", route("modal", "identity"));
    await runtime.handle(open.interaction, { userId: "admin" });
    expect(open.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Edit identity" }),
    );

    const invalid = mockInteraction(
      "modal",
      route("modal-submit", "identity"),
      {
        fields: { getTextInputValue: () => "x" },
      },
    );
    await expect(
      runtime.handle(invalid.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "validation-failed" });
    expect(mutateName).not.toHaveBeenCalled();
    expect(JSON.stringify(invalid.update.mock.calls[0]?.[0])).toContain(
      "Use at least two characters.",
    );

    const retry = mockInteraction("button", route("modal", "identity"));
    await runtime.handle(retry.interaction, { userId: "admin" });
    expect(JSON.stringify(retry.showModal.mock.calls[0]?.[0])).toContain(
      '"value":"x"',
    );

    const valid = mockInteraction(
      "modal",
      route("modal-submit", "identity"),
      {
        fields: { getTextInputValue: () => "Prod Support" },
      },
    );
    await expect(
      runtime.handle(valid.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });
    expect(state.name).toBe("Prod Support");
  });

  it("fails stale versions, missing fields, and mismatched component kinds safely", async () => {
    const unknownVersion = mockInteraction(
      "button",
      "pcs.99.b.setup.general.increment.0",
    );
    const missing = mockInteraction("button", route("button", "missing"));
    const wrongKind = mockInteraction(
      "button",
      route("string-select", "mode"),
    );

    for (const value of [unknownVersion, missing, wrongKind]) {
      await expect(
        runtime.handle(value.interaction, { userId: "admin" }),
      ).resolves.toEqual({ matched: true, status: "stale" });
      expect(value.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("outdated"),
          flags: MessageFlags.Ephemeral,
        }),
      );
    }
  });

  it("denies a mutation before loading or invoking its callback", async () => {
    state.authorized = false;
    const button = mockInteraction("button", route("button", "increment"));

    await expect(
      runtime.handle(button.interaction, { userId: "visitor" }),
    ).resolves.toEqual({ matched: true, status: "unauthorized" });

    expect(state.count).toBe(0);
    expect(authorize).toHaveBeenCalledOnce();
    expect(button.update).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("ignores interactions outside the settings namespace", async () => {
    const unrelated = mockInteraction("button", "another.1.button");

    expect(runtime.matches(unrelated.interaction)).toBe(false);
    await expect(
      runtime.handle(unrelated.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: false });
    expect(unrelated.reply).not.toHaveBeenCalled();
  });
});
