import { slashCommand, type Action } from "protocord";

import type { ProdActionContext } from "./runtime.js";

type PingInput = Readonly<Record<never, never>>;

export const pingAction: Action<PingInput, string, ProdActionContext> = {
  name: "ping",
  description: "Check whether Prod is responsive.",
  input: {
    parse: (input) => {
      if (!input || typeof input !== "object") {
        throw new TypeError("Ping input must be an object");
      }
      return {};
    },
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  triggers: [
    slashCommand({
      name: "ping",
      description: "Check whether Prod is responsive",
      acknowledgement: "public",
      parse: () => ({}),
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => undefined,
  execute: async () => "pong!",
};
