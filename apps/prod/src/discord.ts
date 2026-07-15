import {
  Client,
  Events,
  GatewayIntentBits,
  type ApplicationCommandData,
  type Interaction,
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
  commands: readonly ApplicationCommandData[];
  handleInteraction(interaction: Interaction): Promise<void>;
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
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let closed = false;

  const actions = options.actions;
  if (actions) {
    client.on(Events.InteractionCreate, (interaction) => {
      void actions
        .handleInteraction(interaction)
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

        const removeListeners = () => {
          client.off(Events.ClientReady, handleReady);
          signal.removeEventListener("abort", handleAbort);
        };
        const handleReady = (readyClient: Client<true>) => {
          removeListeners();
          void prepareReadyClient(readyClient, options).then(resolve, reject);
        };
        const handleAbort = () => {
          removeListeners();
          void close();
          reject(signal.reason);
        };

        client.once(Events.ClientReady, handleReady);
        signal.addEventListener("abort", handleAbort, { once: true });
        void client.login(token).catch((error: unknown) => {
          removeListeners();
          reject(error instanceof Error ? error : new Error(String(error)));
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
    const guild =
      client.guilds.cache.get(options.developmentGuildId) ??
      (await client.guilds.fetch(options.developmentGuildId));
    await guild.commands.set(options.actions.commands);
  }

  return {
    userId: client.user.id,
    tag: client.user.tag,
  };
};
