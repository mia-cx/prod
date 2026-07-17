import {
  Client,
  Events,
  GatewayIntentBits,
  TeamMemberMembershipState,
  TeamMemberRole,
  type AnyThreadChannel,
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
  reconcile?(client: Client<true>): Promise<void>;
  handleInteraction(interaction: Interaction): Promise<void>;
  handleMessage?(message: Message): Promise<boolean>;
  handleThread?(thread: AnyThreadChannel): Promise<void>;
  handleError(error: unknown): void;
}>;

export type DiscordGatewayOptions = Readonly<{
  actions?: DiscordActionSurface;
  configuredApplicationOperatorUserIds?: readonly string[];
  applicationOperatorRefreshIntervalMs?: number;
  applicationOperatorMaxStalenessMs?: number;
}>;

const defaultApplicationOperatorRefreshIntervalMs = 5 * 60 * 1_000;
const defaultApplicationOperatorMaxStalenessMs = 15 * 60 * 1_000;
const applicationOperatorTeamRoles = new Set<TeamMemberRole>([
  TeamMemberRole.Admin,
  // Developers can rotate the bot token and therefore already hold bot control.
  TeamMemberRole.Developer,
]);

type DiscordApplicationOwnerLike =
  | Readonly<{ id: string }>
  | Readonly<{
      ownerId: string | null;
      members: Readonly<{
        values(): IterableIterator<
          Readonly<{
            id: string;
            membershipState: TeamMemberMembershipState;
            role: TeamMemberRole;
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
        if (
          member.membershipState === TeamMemberMembershipState.Accepted &&
          (member.id === owner.ownerId ||
            applicationOperatorTeamRoles.has(member.role))
        ) {
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
  let operatorRefreshTimer: NodeJS.Timeout | undefined;
  let operatorExpiryTimer: NodeJS.Timeout | undefined;
  const operatorRefreshIntervalMs =
    options.applicationOperatorRefreshIntervalMs ??
    defaultApplicationOperatorRefreshIntervalMs;
  const operatorMaxStalenessMs =
    options.applicationOperatorMaxStalenessMs ??
    defaultApplicationOperatorMaxStalenessMs;
  if (
    !Number.isFinite(operatorRefreshIntervalMs) ||
    operatorRefreshIntervalMs <= 0 ||
    !Number.isFinite(operatorMaxStalenessMs) ||
    operatorMaxStalenessMs < operatorRefreshIntervalMs
  ) {
    throw new RangeError(
      "Application operator refresh durations must be positive and max staleness must not be shorter than the refresh interval",
    );
  }

  const configuredOperatorUserIds = Object.freeze([
    ...new Set(options.configuredApplicationOperatorUserIds ?? []),
  ]);
  const clearOperatorTimers = (): void => {
    if (operatorRefreshTimer !== undefined) {
      clearTimeout(operatorRefreshTimer);
      operatorRefreshTimer = undefined;
    }
    if (operatorExpiryTimer !== undefined) {
      clearTimeout(operatorExpiryTimer);
      operatorExpiryTimer = undefined;
    }
  };
  const installApplicationOperatorUserIds = (
    userIds: readonly string[],
  ): void => {
    options.actions?.setApplicationOperatorUserIds?.(userIds);
  };
  const scheduleOperatorExpiry = (): void => {
    if (operatorExpiryTimer !== undefined) clearTimeout(operatorExpiryTimer);
    operatorExpiryTimer = setTimeout(() => {
      operatorExpiryTimer = undefined;
      if (!closed) installApplicationOperatorUserIds(configuredOperatorUserIds);
    }, operatorMaxStalenessMs);
    operatorExpiryTimer.unref();
  };
  const scheduleOperatorRefresh = (readyClient: Client<true>): void => {
    operatorRefreshTimer = setTimeout(() => {
      operatorRefreshTimer = undefined;
      if (closed) return;
      void readyClient.application
        .fetch()
        .then((application) => {
          if (closed) return;
          installApplicationOperatorUserIds(
            resolveApplicationOperatorUserIds(
              application.owner,
              configuredOperatorUserIds,
            ),
          );
          scheduleOperatorExpiry();
        })
        .catch((error: unknown) => {
          if (!closed) options.actions?.handleError(error);
        })
        .finally(() => {
          if (!closed) scheduleOperatorRefresh(readyClient);
        });
    }, operatorRefreshIntervalMs);
    operatorRefreshTimer.unref();
  };

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
    if (actions.handleThread) {
      const handleThread = (thread: AnyThreadChannel): void => {
        void actions
          .handleThread!(thread)
          .catch((error: unknown) => actions.handleError(error));
      };
      client.on(Events.ThreadCreate, handleThread);
      client.on(Events.ThreadUpdate, (_oldThread, newThread) => {
        handleThread(newThread);
      });
    }
  }

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    clearOperatorTimers();
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
          const assertActive = (): void => {
            signal.throwIfAborted();
            if (closed) throw new Error("Discord gateway is closed");
          };
          void prepareReadyClient(readyClient, options, assertActive, () => {
            if (options.actions?.setApplicationOperatorUserIds) {
              scheduleOperatorExpiry();
              scheduleOperatorRefresh(readyClient);
            }
          }).then(
            (identity) =>
              settle(() => {
                resolve(identity);
              }),
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
  assertActive: () => void,
  onApplicationOperatorsInstalled?: () => void,
): Promise<DiscordIdentity> => {
  assertActive();
  let applicationOperatorUserIds = resolveApplicationOperatorUserIds(
    null,
    options.configuredApplicationOperatorUserIds,
  );
  options.actions?.setApplicationOperatorUserIds?.(applicationOperatorUserIds);
  const application = await client.application
    .fetch()
    .catch((error: unknown) => {
      assertActive();
      options.actions?.handleError(error);
      return undefined;
    });
  assertActive();
  if (application !== undefined) {
    applicationOperatorUserIds = resolveApplicationOperatorUserIds(
      application.owner,
      options.configuredApplicationOperatorUserIds,
    );
    options.actions?.setApplicationOperatorUserIds?.(
      applicationOperatorUserIds,
    );
  }
  if (options.actions) {
    onApplicationOperatorsInstalled?.();
    await options.actions.refreshCommands(client);
    assertActive();
    await options.actions.reconcile?.(client);
    assertActive();
  }

  return Object.freeze({
    userId: client.user.id,
    tag: client.user.tag,
    applicationOperatorUserIds,
  });
};
