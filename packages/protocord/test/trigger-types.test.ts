import { describe, expect, it } from "vitest";

import { slashCommand, textCommandTrigger, type Action } from "../src/index.js";

type FixtureContext = Readonly<{ events: string[] }>;
type WrongContext = Readonly<{ secret: string }>;
type FixtureCheck = Readonly<{ permission: string }>;
type WrongCheck = Readonly<{ capability: number }>;

const actionWithoutTriggers = {
  name: "typed-fixture",
  description: "Exercise trigger composition types",
  input: {
    parse: (input: unknown) => String(input),
    jsonSchema: { type: "string" },
  },
  availability: () => ({ available: true as const }),
  authorization: () => ({ permission: "fixture.run" }),
  execute: async ({ input }: { input: string }) => input,
} satisfies Omit<
  Action<string, string, FixtureContext, FixtureCheck>,
  "triggers"
>;

const wrongContextTrigger = slashCommand<string, WrongContext, FixtureCheck>({
  name: "wrong-context",
  description: "Requires the wrong presenter context",
  parse: () => "input",
  present: (_outcome, _interaction, context) => {
    void context.secret;
  },
});

const wrongCheckTrigger = slashCommand<string, FixtureContext, WrongCheck>({
  name: "wrong-check",
  description: "Produces the wrong authorization check",
  parse: () => "input",
  autocomplete: {
    availability: () => ({ available: true }),
    access: {
      kind: "authorized",
      authorization: () => ({ capability: 42 }),
    },
    complete: () => [],
  },
});

const wrongContextAction: Action<string, string, FixtureContext, FixtureCheck> =
  {
    ...actionWithoutTriggers,
    triggers: [
      // @ts-expect-error A trigger cannot require an unrelated context.
      wrongContextTrigger,
    ],
  };

const wrongCheckAction: Action<string, string, FixtureContext, FixtureCheck> = {
  ...actionWithoutTriggers,
  triggers: [
    // @ts-expect-error A trigger cannot produce an unrelated check type.
    wrongCheckTrigger,
  ],
};

const genericTrigger = textCommandTrigger({
  name: "generic",
  description: "Uses the default context and no authorization check",
});

const compatibleAction: Action<string, string, FixtureContext, FixtureCheck> = {
  ...actionWithoutTriggers,
  triggers: [genericTrigger],
};

describe("trigger composition types", () => {
  it("keeps generic triggers composable with a typed action", () => {
    expect(compatibleAction.triggers).toEqual([genericTrigger]);
    expect(wrongContextAction.triggers).toEqual([wrongContextTrigger]);
    expect(wrongCheckAction.triggers).toEqual([wrongCheckTrigger]);
  });
});
