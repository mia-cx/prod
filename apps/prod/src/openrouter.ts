export type OpenRouterFailure =
  "timeout" | "rate_limited" | "auth" | "provider" | "invalid_response";

export class OpenRouterError extends Error {
  override readonly name = "OpenRouterError";

  constructor(public readonly kind: OpenRouterFailure) {
    super(`OpenRouter request failed: ${kind}`);
  }
}

export type ToolCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
}>;

export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string | null;
  tool_calls?: readonly ToolCall[];
}>;

export type OpenRouterRequest = Readonly<{
  apiKey: string;
  model: string;
  messages: readonly Readonly<Record<string, unknown>>[];
  tools?: readonly Readonly<Record<string, unknown>>[];
  tool_choice?: "required" | "auto";
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseMessage = (body: unknown): AssistantMessage => {
  if (!record(body) || !Array.isArray(body.choices)) {
    throw new OpenRouterError("invalid_response");
  }
  const choice: unknown = body.choices[0];
  const message = record(choice) ? choice.message : undefined;
  if (
    !record(message) ||
    message.role !== "assistant" ||
    !(message.content === null || typeof message.content === "string")
  )
    throw new OpenRouterError("invalid_response");
  const calls = message.tool_calls;
  if (
    calls !== undefined &&
    (!Array.isArray(calls) ||
      !calls.every(
        (call: unknown) =>
          record(call) &&
          typeof call.id === "string" &&
          call.id.length > 0 &&
          call.type === "function" &&
          record(call.function) &&
          typeof call.function.name === "string" &&
          call.function.name.length > 0 &&
          typeof call.function.arguments === "string",
      ))
  )
    throw new OpenRouterError("invalid_response");
  if (
    !(typeof message.content === "string" && message.content.trim()) &&
    !(Array.isArray(calls) && calls.length > 0)
  ) {
    throw new OpenRouterError("invalid_response");
  }
  return {
    role: "assistant",
    content: message.content,
    ...(calls === undefined ? {} : { tool_calls: calls as ToolCall[] }),
  };
};

export const createOpenRouterClient = (
  options: Readonly<{
    fetch?: typeof fetch;
    timeoutMs?: number;
  }> = {},
) => ({
  complete: async (request: OpenRouterRequest): Promise<AssistantMessage> => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    try {
      const response = await (options.fetch ?? fetch)(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${request.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            tool_choice: request.tool_choice ?? "auto",
          }),
        },
      );
      if (!response.ok) {
        throw new OpenRouterError(
          response.status === 429
            ? "rate_limited"
            : response.status === 401 || response.status === 403
              ? "auth"
              : "provider",
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new OpenRouterError(
          signal.aborted ? "timeout" : "invalid_response",
        );
      }
      return parseMessage(body);
    } catch (error) {
      if (signal.aborted) throw new OpenRouterError("timeout");
      if (error instanceof OpenRouterError) throw error;
      throw new OpenRouterError("provider");
    }
  },
});
