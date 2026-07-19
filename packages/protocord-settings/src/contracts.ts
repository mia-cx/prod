import type {
  ButtonStyle,
  ChannelType,
  TextInputStyle,
} from "discord.js";

export type Awaitable<Value> = Value | Promise<Value>;

export type SettingsAuthorizationDecision =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason?: string }>;

export type SettingsAuthorization<Context> = (
  context: Context,
) => Awaitable<boolean | SettingsAuthorizationDecision>;

export type SettingsValidationIssue = Readonly<{
  message: string;
  inputId?: string;
}>;

export type SettingsMutationResult =
  | Readonly<{ status: "success" }>
  | Readonly<{
      status: "invalid";
      issues: readonly SettingsValidationIssue[];
    }>;

export type SettingsMutationCallbackResult = void | SettingsMutationResult;

export type SettingsFieldView = Readonly<{
  value?: string;
  disabled?: boolean;
}>;

type SettingsFieldBase<Kind extends string, Context> = Readonly<{
  kind: Kind;
  id: string;
  label: string;
  description?: string;
  visible?(context: Context): Awaitable<boolean>;
}>;

export type SettingsDisplayField<Context> = SettingsFieldBase<"display", Context> &
  Readonly<{
    presentation?: Readonly<{ kind: "plain" }>;
    load(context: Context): Awaitable<SettingsFieldView & { value: string }>;
  }>;

export type SettingsButtonView = SettingsFieldView &
  Readonly<{ buttonLabel?: string }>;

export type SettingsButtonField<Context> = SettingsFieldBase<"button", Context> &
  Readonly<{
    style?: Exclude<ButtonStyle, ButtonStyle.Link | ButtonStyle.Premium>;
    load(context: Context): Awaitable<SettingsButtonView>;
    mutate(context: Context): Awaitable<SettingsMutationCallbackResult>;
  }>;

export type SettingsSelectOption = Readonly<{
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}>;

export type SettingsStringSelectView = SettingsFieldView &
  Readonly<{
    options: readonly SettingsSelectOption[];
    selectedValues?: readonly string[];
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
  }>;

export type SettingsStringSelectPresentation = Readonly<{
  kind: "plain";
  separator?: boolean;
}>;

export type SettingsStringSelectField<Context> =
  SettingsFieldBase<"string-select", Context> &
    Readonly<{
      presentation?: SettingsStringSelectPresentation;
      load(context: Context): Awaitable<SettingsStringSelectView>;
      validate?(
        values: readonly string[],
        context: Context,
      ): Awaitable<readonly SettingsValidationIssue[]>;
      mutate(
        values: readonly string[],
        context: Context,
      ): Awaitable<SettingsMutationCallbackResult>;
    }>;

export type SettingsMentionableReference =
  | Readonly<{ kind: "user"; id: string }>
  | Readonly<{ kind: "role"; id: string }>;

export type SettingsMentionable =
  | Readonly<{
      kind: "user";
      id: string;
      user: Readonly<{
        id: string;
        username: string;
        globalName: string | null;
      }>;
    }>
  | Readonly<{
      kind: "role";
      id: string;
      role: Readonly<{ id: string; name: string }>;
    }>;

export type SettingsMentionableSelectView = SettingsFieldView &
  Readonly<{
    defaults?: readonly SettingsMentionableReference[];
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
  }>;

export type SettingsFieldLoadPurpose = "render" | "mutation";

export type SettingsMentionableSelectField<Context> =
  SettingsFieldBase<"mentionable-select", Context> &
    Readonly<{
      load(
        context: Context,
        purpose?: SettingsFieldLoadPurpose,
      ): Awaitable<SettingsMentionableSelectView>;
      validate?(
        values: readonly SettingsMentionable[],
        context: Context,
      ): Awaitable<readonly SettingsValidationIssue[]>;
      mutate(
        values: readonly SettingsMentionable[],
        context: Context,
      ): Awaitable<SettingsMutationCallbackResult>;
    }>;

export type SettingsChannel = Readonly<{
  id: string;
  channel: Readonly<{
    id: string;
    name: string;
    type: ChannelType;
  }>;
}>;

export type SettingsChannelSelectView = SettingsFieldView &
  Readonly<{
    defaultChannelIds?: readonly string[];
    channelTypes?: readonly ChannelType[];
    placeholder?: string;
    minValues?: number;
    maxValues?: number;
  }>;

export type SettingsChannelSelectField<Context> =
  SettingsFieldBase<"channel-select", Context> &
    Readonly<{
      load(context: Context): Awaitable<SettingsChannelSelectView>;
      validate?(
        values: readonly SettingsChannel[],
        context: Context,
      ): Awaitable<readonly SettingsValidationIssue[]>;
      mutate(
        values: readonly SettingsChannel[],
        context: Context,
      ): Awaitable<SettingsMutationCallbackResult>;
    }>;

type SettingsModalInputBase = Readonly<{
  id: string;
  label: string;
  description?: string;
}>;

export type SettingsModalTextInput = SettingsModalInputBase &
  Readonly<{
    kind?: "text";
    style?: TextInputStyle;
    placeholder?: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
  }>;

export type SettingsModalCheckboxInput = SettingsModalInputBase &
  Readonly<{
    kind: "checkbox";
  }>;

export type SettingsModalInput =
  | SettingsModalTextInput
  | SettingsModalCheckboxInput;

export type SettingsModalValue = string | boolean;
export type SettingsModalValues = Readonly<Record<string, SettingsModalValue>>;

export type SettingsModalView = SettingsFieldView &
  Readonly<{
    buttonLabel?: string;
    values?: SettingsModalValues;
  }>;

export type SettingsModalPresentation =
  | Readonly<{ kind: "inline" }>
  | Readonly<{ kind: "section" }>
  | Readonly<{ kind: "preview"; maxLength: number }>;

export type SettingsModalField<Context> = SettingsFieldBase<"modal", Context> &
  Readonly<{
    title: string;
    inputs: readonly SettingsModalInput[];
    presentation?: SettingsModalPresentation;
    draftScope?(context: Context): Awaitable<string>;
    load(context: Context): Awaitable<SettingsModalView>;
    validate?(
      values: SettingsModalValues,
      context: Context,
    ): Awaitable<readonly SettingsValidationIssue[]>;
    mutate(
      values: SettingsModalValues,
      context: Context,
    ): Awaitable<SettingsMutationCallbackResult>;
  }>;

export type SettingsActionRowItem<Context> =
  | SettingsButtonField<Context>
  | SettingsModalField<Context>;

export type SettingsActionRowField<Context> =
  SettingsFieldBase<"action-row", Context> &
    Readonly<{
      items: readonly SettingsActionRowItem<Context>[];
    }>;

export type SettingsContainerChildField<Context> =
  | SettingsDisplayField<Context>
  | SettingsButtonField<Context>
  | SettingsActionRowField<Context>
  | SettingsStringSelectField<Context>
  | SettingsMentionableSelectField<Context>
  | SettingsChannelSelectField<Context>
  | SettingsModalField<Context>;

export type SettingsContainerField<Context> =
  SettingsFieldBase<"container", Context> &
    Readonly<{
      fields: readonly SettingsContainerChildField<Context>[];
    }>;

export type SettingsField<Context> =
  | SettingsContainerChildField<Context>
  | SettingsContainerField<Context>;

export type SettingsSubcategory<Context> = Readonly<{
  id: string;
  label: string;
  description?: string;
  fields: readonly SettingsField<Context>[];
}>;

export type SettingsCategory<Context> = Readonly<{
  id: string;
  label: string;
  description?: string;
  authorize: SettingsAuthorization<Context>;
  fields?: readonly SettingsField<Context>[];
  subcategories?: readonly SettingsSubcategory<Context>[];
}>;

export type SettingsDefinition<Context> = Readonly<{
  title: string;
  categories: readonly SettingsCategory<Context>[];
  accentColor?: number;
}>;

export function defineSettingsField<Context>(
  field: SettingsField<Context>,
): SettingsField<Context> {
  return field;
}

export function defineSettingsSubcategory<Context>(
  subcategory: SettingsSubcategory<Context>,
): SettingsSubcategory<Context> {
  return subcategory;
}

export function defineSettingsCategory<Context>(
  category: SettingsCategory<Context>,
): SettingsCategory<Context> {
  return category;
}
