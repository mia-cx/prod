import {
  messageContextMenu,
  slashCommand,
  textCommandTrigger,
  userContextMenu,
  type Action,
} from "protocord";

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
      acknowledgement: "none",
      visibility: "public",
      parse: () => ({}),
    }),
    messageContextMenu({
      name: "Ping Prod",
      acknowledgement: "none",
      visibility: "public",
      parse: () => ({}),
    }),
    userContextMenu({
      name: "Ping Prod",
      acknowledgement: "none",
      visibility: "public",
      parse: () => ({}),
    }),
    textCommandTrigger({
      name: "ping",
      description: "Check whether Prod is responsive",
      parse: () => ({}),
    }),
  ],
  availability: () => ({ available: true }),
  authorization: () => undefined,
  execute: async () => "pong!",
};
