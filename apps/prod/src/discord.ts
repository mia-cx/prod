import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
} from "discord.js";

export type DiscordIdentity = Readonly<{
  userId: string;
  tag: string;
}>;

export interface DiscordGateway {
  connect(token: string, signal: AbortSignal): Promise<DiscordIdentity>;
  close(): Promise<void>;
}

export type DiscordActionSurface = Readonly<{
  refreshCommands(
    client: Client<true>,
    developmentGuildId: string,
  ): Promise<void>;
  handleInteraction(interaction: Interaction): Promise<void>;
  handleMessage(message: Message): Promise<boolean>;
  handleError(error: unknown): void;
}>;

export type DiscordGatewayOptions =
  | Readonly<{
      actions?: undefined;
      developmentGuildId?: undefined;
    }>
  | Readonly<{
      actions: DiscordActionSurface;
      developmentGuildId: string;
    }>;

export const createDiscordGateway = (
  options: DiscordGatewayOptions = {},
): DiscordGateway => {
  const actions = options.actions;
  const client = new Client({
    intents: actions
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
    client.on(Events.MessageCreate, (message) => {
      void actions
        .handleMessage(message)
        .catch((error: unknown) => actions.handleError(error));
    });
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
  if (options.actions) {
    await options.actions.refreshCommands(client, options.developmentGuildId);
  }

  return {
    userId: client.user.id,
    tag: client.user.tag,
  };
};
