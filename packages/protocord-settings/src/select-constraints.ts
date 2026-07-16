import { SETTINGS_LIMITS } from "./definition.js";

export type ResolvedSelectBounds = Readonly<{
  minimum: number;
  maximum: number;
}>;

export class SettingsSelectConstraintError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettingsSelectConstraintError";
  }
}

export function resolveSelectBounds(input: Readonly<{
  fieldId: string;
  optionCount?: number;
  minimum?: number;
  maximum?: number;
}>): ResolvedSelectBounds {
  if (
    input.optionCount !== undefined &&
    input.optionCount > SETTINGS_LIMITS.selectOptions
  ) {
    fail(
      input.fieldId,
      `may provide at most ${SETTINGS_LIMITS.selectOptions} options`,
    );
  }
  const maximum = input.maximum ?? 1;
  const minimum = input.minimum ?? 1;
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < 1 ||
    maximum > SETTINGS_LIMITS.selectOptions ||
    minimum > maximum ||
    (input.optionCount !== undefined && maximum > input.optionCount)
  ) {
    fail(input.fieldId, "has invalid select minimum/maximum values");
  }
  return { minimum, maximum };
}

export function assertSelectionCount(
  fieldId: string,
  count: number,
  bounds: ResolvedSelectBounds,
  kind: "current selection" | "default selection",
  allowEmpty: boolean,
): void {
  if (allowEmpty && count === 0) {
    return;
  }
  if (count < bounds.minimum || count > bounds.maximum) {
    fail(
      fieldId,
      `${kind} count must be between ${String(bounds.minimum)} and ${String(bounds.maximum)}`,
    );
  }
}

function fail(fieldId: string, message: string): never {
  throw new SettingsSelectConstraintError(
    `settings field ${fieldId} ${message}`,
  );
}

