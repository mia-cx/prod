import { Client, Events, GatewayIntentBits } from "discord.js";

export type DiscordIdentity = Readonly<{
  userId: string;
  tag: string;
}>;

export interface DiscordGateway {
  connect(token: string, signal: AbortSignal): Promise<DiscordIdentity>;
  close(): Promise<void>;
}

export const createDiscordGateway = (): DiscordGateway => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let closed = false;

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
          resolve({
            userId: readyClient.user.id,
            tag: readyClient.user.tag,
          });
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
