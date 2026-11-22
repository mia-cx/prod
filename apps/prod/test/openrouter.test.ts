import { describe, expect, it, vi } from "vitest";

import { createOpenRouterClient, OpenRouterError } from "../src/openrouter.js";

const request = {
  apiKey: "secret-test-key",
  model: "test/model",
  messages: [{ role: "user", content: "help" }],
};
const response = (message: unknown) =>
  Response.json({ choices: [{ message }] });

describe("OpenRouter client", () => {
  it("posts the model, messages and tools and parses assistant tool calls", async () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "complete", arguments: "{}" },
        },
      ],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(message));
    const tools = [{ type: "function", function: { name: "complete" } }];
    expect(
      await createOpenRouterClient({ fetch }).complete({
        ...request,
        tools,
        tool_choice: "required",
      }),
    ).toEqual(message);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer secret-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: request.model,
      messages: request.messages,
      tools,
      tool_choice: "required",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("supports plain assistant text with automatic tool choice", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response({ role: "assistant", content: "what happened?" }),
      );
    expect(await createOpenRouterClient({ fetch }).complete(request)).toEqual({
      role: "assistant",
      content: "what happened?",
    });
    expect(
      JSON.parse(fetch.mock.calls[0]![1]!.body as string).tool_choice,
    ).toBe("auto");
  });

  it.each([
    [429, "rate_limited"],
    [401, "auth"],
    [403, "auth"],
    [500, "provider"],
    [400, "provider"],
  ])("maps HTTP %s without exposing response bodies", async (status, kind) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(request.apiKey, { status: status as number }),
      );
    const error = await createOpenRouterClient({ fetch })
      .complete(request)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error).toMatchObject({ kind });
    expect(String(error)).not.toContain(request.apiKey);
  });

  it.each([
    {},
    { role: "user", content: "hello" },
    { role: "assistant", content: "" },
    { role: "assistant", content: null },
    { role: "assistant", content: null, tool_calls: [{}] },
  ])("rejects malformed or empty assistant output: %j", async (message) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(message));
    await expect(
      createOpenRouterClient({ fetch }).complete(request),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects invalid JSON and missing choices", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(request.apiKey))
      .mockResolvedValueOnce(Response.json({}));
    const client = createOpenRouterClient({ fetch });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.complete(request)).rejects.toMatchObject({
        kind: "invalid_response",
      });
    }
  });

  it("sanitizes network errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(request.apiKey));
    await expect(
      createOpenRouterClient({ fetch }).complete(request),
    ).rejects.toThrow("OpenRouter request failed: provider");
  });

  it("aborts timed out requests without retaining the transport error", async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error(request.apiKey)),
          { once: true },
        );
      });
    await expect(
      createOpenRouterClient({ fetch, timeoutMs: 1 }).complete(request),
    ).rejects.toThrow("OpenRouter request failed: timeout");
  });
});
