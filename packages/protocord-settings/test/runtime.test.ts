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
  identityDisabled: false,
  mentionableMaximum: 10,
  allowedChannelTypes: [ChannelType.GuildText] as readonly ChannelType[],
  incrementGate: undefined as Promise<void> | undefined,
  incrementStarted: false,
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
              mutate: async () => {
                state.incrementStarted = true;
                await state.incrementGate;
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
              load: () => ({
                value: `${String(state.mentionables.length)} selected`,
                maxValues: state.mentionableMaximum,
              }),
              mutate: mutateMentionables,
            },
            {
              kind: "channel-select",
              id: "hub",
              label: "Hub",
              load: () => ({
                value: state.channels[0]?.channel.name ?? "None",
                channelTypes: state.allowedChannelTypes,
              }),
              mutate: mutateChannels,
            },
            {
              kind: "modal",
              id: "identity",
              label: "Identity",
              title: "Edit identity",
              inputs: [{ id: "name", label: "Name", minLength: 2 }],
              load: () => ({
                value: state.name,
                values: { name: state.name },
                disabled: state.identityDisabled,
              }),
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
  editReply: ReturnType<typeof vi.fn>;
  deferUpdate: ReturnType<typeof vi.fn>;
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
  const editReply = vi.fn(async () => undefined);
  const showModal = vi.fn(async () => undefined);
  const interactionState: Record<string, unknown> = {
    customId,
    user: { id: "admin" },
    message: { id: "message-1" },
    replied: false,
    deferred: false,
    reply,
    followUp,
    update,
    editReply,
    deferUpdate: vi.fn(async () => {
      interactionState.deferred = true;
    }),
    showModal,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isMentionableSelectMenu: () => kind === "mentionable",
    isChannelSelectMenu: () => kind === "channel",
    isModalSubmit: () => kind === "modal",
    isFromMessage: () => kind === "modal",
    ...extra,
  };
  const interaction = interactionState as unknown as Interaction;
  return {
    interaction,
    reply,
    followUp,
    update,
    editReply,
    deferUpdate: interactionState.deferUpdate as ReturnType<typeof vi.fn>,
    showModal,
  };
}

function mockCommand(
  initial: {
    deferred?: boolean;
    replied?: boolean;
    ephemeral?: boolean | null;
  } = {},
): {
  interaction: RepliableInteraction;
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const interactionState: Record<string, unknown> = {
    replied: initial.replied ?? false,
    deferred: initial.deferred ?? false,
    ephemeral:
      initial.ephemeral ?? (initial.deferred === true ? true : null),
    reply,
    editReply,
    deferReply: vi.fn(async () => {
      interactionState.deferred = true;
      interactionState.ephemeral = true;
    }),
    followUp: vi.fn(async () => undefined),
  };
  return {
    interaction: interactionState as unknown as RepliableInteraction,
    reply,
    deferReply: interactionState.deferReply as ReturnType<typeof vi.fn>,
    editReply,
    followUp: interactionState.followUp as ReturnType<typeof vi.fn>,
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
    state.identityDisabled = false;
    state.mentionableMaximum = 10;
    state.allowedChannelTypes = [ChannelType.GuildText];
    state.incrementGate = undefined;
    state.incrementStarted = false;
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
    expect(command.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(command.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.IsComponentsV2,
        components: expect.any(Array),
        allowedMentions: { parse: [], repliedUser: false },
      }),
    );
  });

  it("edits a command response that was already deferred", async () => {
    const command = mockCommand({ deferred: true });

    await expect(
      runtime.open(command.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "opened" });

    expect(command.deferReply).not.toHaveBeenCalled();
    expect(command.reply).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.IsComponentsV2 }),
    );
  });

  it("keeps settings private when a caller deferred publicly", async () => {
    const command = mockCommand({ deferred: true, ephemeral: false });

    await runtime.open(command.interaction, { userId: "admin" });

    expect(command.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Settings opened in a private response.",
      }),
    );
    expect(command.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
      }),
    );
  });

  it("keeps open errors private when a caller deferred publicly", async () => {
    state.authorized = false;
    const command = mockCommand({ deferred: true, ephemeral: false });

    await expect(
      runtime.open(command.interaction, { userId: "visitor" }),
    ).resolves.toEqual({ matched: true, status: "unauthorized" });

    expect(command.editReply).toHaveBeenCalledWith({
      content: "Settings could not be opened here.",
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(command.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("authorized") }),
    );
    expect(command.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to view settings.",
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it("bounds modal preparation to Discord's response window", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const authorization = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const category = definition.categories[0]!;
    const slowRuntime = createSettingsRuntime({
      definition: {
        ...definition,
        categories: [{ ...category, authorize: () => authorization }],
      },
    });
    const modal = mockInteraction("button", route("modal", "identity"));

    try {
      const handling = slowRuntime.handle(modal.interaction, {
        userId: "admin",
      });
      await vi.advanceTimersByTimeAsync(2_500);

      await expect(handling).resolves.toEqual({
        matched: true,
        status: "failed",
      });
      expect(modal.showModal).not.toHaveBeenCalled();
      expect(modal.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("too long") }),
      );
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it("rechecks authorization, mutates a button, and rerenders", async () => {
    const button = mockInteraction("button", route("button", "increment"));

    expect(runtime.matches(button.interaction)).toBe(true);
    await expect(
      runtime.handle(button.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });

    expect(state.count).toBe(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(button.editReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(button.editReply.mock.calls[0]?.[0])).toContain(
      "Increment updated.",
    );
  });

  it("acknowledges a mutation before awaiting consumer callbacks", async () => {
    let release: (() => void) | undefined;
    state.incrementGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const button = mockInteraction("button", route("button", "increment"));

    const handling = runtime.handle(button.interaction, { userId: "admin" });
    await vi.waitFor(() => expect(state.incrementStarted).toBe(true));
    const acknowledgementsBeforeRelease = button.deferUpdate.mock.calls.length;
    release?.();
    await handling;

    expect(acknowledgementsBeforeRelease).toBe(1);
  });

  it("validates selected options and rerenders their new values", async () => {
    const select = mockInteraction("string", route("string-select", "mode"), {
      values: ["direct"],
    });

    await expect(
      runtime.handle(select.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "mutated" });

    expect(state.mode).toBe("direct");
    expect(JSON.stringify(select.editReply.mock.calls[0]?.[0])).toContain(
      "direct",
    );
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
    expect(JSON.stringify(invalid.editReply.mock.calls[0]?.[0])).toContain(
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

  it("isolates modal drafts to their originating settings message", async () => {
    const invalid = mockInteraction(
      "modal",
      route("modal-submit", "identity"),
      {
        message: { id: "message-a" },
        fields: { getTextInputValue: () => "x" },
      },
    );
    await runtime.handle(invalid.interaction, { userId: "admin" });

    const otherMessage = mockInteraction(
      "button",
      route("modal", "identity"),
      { message: { id: "message-b" } },
    );
    await runtime.handle(otherMessage.interaction, { userId: "admin" });
    expect(JSON.stringify(otherMessage.showModal.mock.calls[0]?.[0])).toContain(
      '"value":"Prod"',
    );

    const sameMessage = mockInteraction(
      "button",
      route("modal", "identity"),
      { message: { id: "message-a" } },
    );
    await runtime.handle(sameMessage.interaction, { userId: "admin" });
    expect(JSON.stringify(sameMessage.showModal.mock.calls[0]?.[0])).toContain(
      '"value":"x"',
    );
  });

  it("expires abandoned modal drafts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const invalid = mockInteraction(
        "modal",
        route("modal-submit", "identity"),
        { fields: { getTextInputValue: () => "x" } },
      );
      await runtime.handle(invalid.interaction, { userId: "admin" });
      vi.setSystemTime(new Date("2026-01-01T00:16:00Z"));

      const retry = mockInteraction("button", route("modal", "identity"));
      await runtime.handle(retry.interaction, { userId: "admin" });

      expect(JSON.stringify(retry.showModal.mock.calls[0]?.[0])).toContain(
        '"value":"Prod"',
      );
    } finally {
      vi.useRealTimers();
    }
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
    expect(button.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });

  it("rejects stale selections against freshly loaded field constraints", async () => {
    state.mentionableMaximum = 1;
    const users = new Collection<string, never>();
    users.set(
      "user-1",
      { id: "user-1", username: "mia", globalName: "Mia" } as never,
    );
    users.set(
      "user-2",
      { id: "user-2", username: "sam", globalName: "Sam" } as never,
    );
    const mentionable = mockInteraction(
      "mentionable",
      route("mentionable-select", "staff"),
      { values: ["user-1", "user-2"], users, roles: new Collection() },
    );

    await expect(
      runtime.handle(mentionable.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "stale" });
    expect(mutateMentionables).not.toHaveBeenCalled();

    const channels = new Collection<string, never>();
    channels.set(
      "voice-1",
      { id: "voice-1", name: "voice", type: ChannelType.GuildVoice } as never,
    );
    const channel = mockInteraction(
      "channel",
      route("channel-select", "hub"),
      { values: ["voice-1"], channels },
    );

    await expect(
      runtime.handle(channel.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "stale" });
    expect(mutateChannels).not.toHaveBeenCalled();
  });

  it("rejects a modal that becomes disabled before submission", async () => {
    state.identityDisabled = true;
    const submit = mockInteraction(
      "modal",
      route("modal-submit", "identity"),
      { fields: { getTextInputValue: () => "Changed" } },
    );

    await expect(
      runtime.handle(submit.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "stale" });
    expect(mutateName).not.toHaveBeenCalled();
  });

  it("treats modal routes targeting another field kind as stale", async () => {
    const modal = mockInteraction("button", route("modal", "increment"));

    await expect(
      runtime.handle(modal.interaction, { userId: "admin" }),
    ).resolves.toEqual({ matched: true, status: "stale" });
    expect(modal.showModal).not.toHaveBeenCalled();
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
