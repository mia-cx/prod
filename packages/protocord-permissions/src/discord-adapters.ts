import type {
  AuthorizationContext,
  UserAuthorizationSubject,
} from "./contracts.js";
import { validateAuthorizationContext } from "./validation.js";

export type DiscordGuildLike = Readonly<{
  id: string;
  ownerId: string;
}>;

export type DiscordMemberLike = Readonly<{
  id: string;
  guild: DiscordGuildLike;
  roles: Readonly<{
    cache: Readonly<{
      values(): IterableIterator<Readonly<{ id: string }>>;
    }>;
  }>;
  permissions: Readonly<{
    has(permission: "Administrator"): boolean;
  }>;
}>;

export type CreateDiscordUserSubjectOptions = Readonly<{
  isApplicationOperator?: (userId: string) => boolean;
}>;

export type DiscordCategoryLike = Readonly<{
  id: string;
  guildId: string;
}>;

export type DiscordChannelLike = Readonly<{
  id: string;
  guildId: string;
  parentId?: string | null;
  parent?: Readonly<{ parentId?: string | null }> | null;
  isThread?(): boolean;
}>;

export class InvalidDiscordAuthorizationContextError extends Error {
  override readonly name = "InvalidDiscordAuthorizationContextError";
}

export type DiscordAuthorizationLocation = Readonly<{
  guild: DiscordGuildLike;
  category?: DiscordCategoryLike;
  channel?: DiscordChannelLike;
}>;

const categoryIdForChannel = (
  channel: DiscordChannelLike,
): string | undefined => {
  if (channel.isThread?.() === true) {
    if (channel.parent === null || channel.parent === undefined) {
      throw new InvalidDiscordAuthorizationContextError(
        "A thread parent is required to derive its complete category context",
      );
    }
    return channel.parent.parentId ?? undefined;
  }
  return channel.parentId ?? undefined;
};

export const createDiscordAuthorizationContext = (
  location: DiscordAuthorizationLocation,
): AuthorizationContext => {
  if (
    location.category?.guildId !== undefined &&
    location.category.guildId !== location.guild.id
  ) {
    throw new InvalidDiscordAuthorizationContextError(
      "The category does not belong to the supplied guild",
    );
  }
  if (
    location.channel?.guildId !== undefined &&
    location.channel.guildId !== location.guild.id
  ) {
    throw new InvalidDiscordAuthorizationContextError(
      "The channel does not belong to the supplied guild",
    );
  }

  const derivedCategoryId =
    location.channel === undefined
      ? undefined
      : categoryIdForChannel(location.channel);
  if (
    location.category !== undefined &&
    location.channel !== undefined &&
    derivedCategoryId !== location.category.id
  ) {
    throw new InvalidDiscordAuthorizationContextError(
      "The channel does not belong to the supplied category",
    );
  }

  const categoryId = location.category?.id ?? derivedCategoryId;
  const context: AuthorizationContext = {
    guildId: location.guild.id,
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(location.channel === undefined
      ? {}
      : { channelId: location.channel.id }),
  };
  validateAuthorizationContext(context);
  return Object.freeze(context);
};

export const createDiscordUserSubject = (
  member: DiscordMemberLike,
  context: AuthorizationContext,
  options: CreateDiscordUserSubjectOptions = {},
): UserAuthorizationSubject => {
  validateAuthorizationContext(context);
  if (member.guild.id !== context.guildId) {
    throw new InvalidDiscordAuthorizationContextError(
      "The member does not belong to the authorization context guild",
    );
  }

  const discordRoleIds = [...member.roles.cache.values()]
    .map((role) => role.id)
    .filter((roleId) => roleId !== member.guild.id)
    .sort();
  return Object.freeze({
    subjectType: "user",
    subjectId: member.id,
    attributes: Object.freeze({
      discordRoleIds: Object.freeze(discordRoleIds),
      isGuildOwner: member.id === member.guild.ownerId,
      isAdministrator: member.permissions.has("Administrator"),
      isApplicationOperator:
        options.isApplicationOperator?.(member.id) ?? false,
    }),
  });
};
