import {
  Client,
  Events,
  GatewayIntentBits,
  TeamMemberMembershipState,
  type Interaction,
  type Message,
} from "discord.js";

export type DiscordIdentity = Readonly<{
  userId: string;
  tag: string;
  applicationOperatorUserIds: readonly string[];
}>;

export interface DiscordGateway {
  connect(token: string, signal: AbortSignal): Promise<DiscordIdentity>;
  close(): Promise<void>;
}

export type DiscordActionSurface = Readonly<{
  setApplicationOperatorUserIds?(userIds: readonly string[]): void;
  refreshCommands(client: Client<true>): Promise<void>;
  handleInteraction(interaction: Interaction): Promise<void>;
  handleMessage?(message: Message): Promise<boolean>;
  handleError(error: unknown): void;
}>;

export type DiscordGatewayOptions = Readonly<{
  actions?: DiscordActionSurface;
  configuredApplicationOperatorUserIds?: readonly string[];
}>;

type DiscordApplicationOwnerLike =
  | Readonly<{ id: string }>
  | Readonly<{
      members: Readonly<{
        values(): IterableIterator<
          Readonly<{
            id: string;
            membershipState: TeamMemberMembershipState;
          }>
        >;
      }>;
    }>;

const isTeamOwner = (
  owner: DiscordApplicationOwnerLike,
): owner is Extract<DiscordApplicationOwnerLike, { members: unknown }> =>
  "members" in owner;

export const resolveApplicationOperatorUserIds = (
  owner: DiscordApplicationOwnerLike | null,
  configuredUserIds: readonly string[] = [],
): readonly string[] => {
  const userIds = new Set(configuredUserIds);
  if (owner !== null) {
    if (isTeamOwner(owner)) {
      for (const member of owner.members.values()) {
        if (member.membershipState === TeamMemberMembershipState.Accepted) {
          userIds.add(member.id);
        }
      }
    } else {
      userIds.add(owner.id);
    }
  }
  return Object.freeze([...userIds].sort());
};

export const createDiscordGateway = (
  options: DiscordGatewayOptions = {},
): DiscordGateway => {
  const actions = options.actions;
  const handleMessage = actions?.handleMessage;
  const client = new Client({
    intents: handleMessage
      ? [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ]
      : [GatewayIntentBits.Guilds],
  });
  let closed = false;

  if (actions) {
    client.on(Events.InteractionCreate, (interaction) => {
      void actions
        .handleInteraction(interaction)
        .catch((error: unknown) => actions.handleError(error));
    });
    if (handleMessage) {
      client.on(Events.MessageCreate, (message) => {
        void handleMessage(message).catch((error: unknown) =>
          actions.handleError(error),
        );
      });
    }
  }

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    client.destroy();
  };

  return {
    connect: (token, signal) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted();
        if (closed) {
          reject(new Error("Discord gateway is closed"));
          return;
        }

        let settled = false;
        const removeListeners = () => {
          client.off(Events.ClientReady, handleReady);
          signal.removeEventListener("abort", handleAbort);
        };
        const settle = (complete: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          removeListeners();
          complete();
        };
        const handleReady = (readyClient: Client<true>) => {
          client.off(Events.ClientReady, handleReady);
          void prepareReadyClient(readyClient, options).then(
            (identity) => settle(() => resolve(identity)),
            (error: unknown) => settle(() => reject(error)),
          );
        };
        const handleAbort = () => {
          settle(() => {
            void close();
            reject(signal.reason);
          });
        };

        client.once(Events.ClientReady, handleReady);
        signal.addEventListener("abort", handleAbort, { once: true });
        void client.login(token).catch((error: unknown) => {
          settle(() =>
            reject(error instanceof Error ? error : new Error(String(error))),
          );
        });
      }),
    close,
  };
};

const prepareReadyClient = async (
  client: Client<true>,
  options: DiscordGatewayOptions,
): Promise<DiscordIdentity> => {
  const application = await client.application.fetch();
  const applicationOperatorUserIds = resolveApplicationOperatorUserIds(
    application.owner,
    options.configuredApplicationOperatorUserIds,
  );
  if (options.actions) {
    options.actions.setApplicationOperatorUserIds?.(applicationOperatorUserIds);
    await options.actions.refreshCommands(client);
  }

  return Object.freeze({
    userId: client.user.id,
    tag: client.user.tag,
    applicationOperatorUserIds,
  });
};
