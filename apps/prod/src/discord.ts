import { Client, Events, GatewayIntentBits } from "discord.js";

export type DiscordIdentity = Readonly<{
  userId: string;
  tag: string;
}>;

export interface DiscordGateway {
  connect(token: string): Promise<DiscordIdentity>;
  close(): Promise<void>;
}

export const createDiscordGateway = (): DiscordGateway => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let closed = false;

  return {
    connect: (token) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("Discord gateway is closed"));
          return;
        }

        const handleReady = (readyClient: Client<true>) => {
          resolve({
            userId: readyClient.user.id,
            tag: readyClient.user.tag,
          });
        };

        client.once(Events.ClientReady, handleReady);
        void client.login(token).catch((error: unknown) => {
          client.off(Events.ClientReady, handleReady);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      client.destroy();
    },
  };
};

