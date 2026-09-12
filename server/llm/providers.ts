import type { ContentBlockParam, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import type { ResolvedConfig } from "./configs";
import type { ChatMessage, LLM, LlmRequest, LlmResponse } from "./types";

const MAX_OUTPUT_TOKENS = 1024;
// Recording a full task set is a long burst of calls, and a rate limit in the
// middle would otherwise fail the run and waste everything recorded so far.
// Both SDKs honour Retry-After and back off between attempts.
const MAX_RETRIES = 8;

export function providerLLM(config: ResolvedConfig): LLM {
  return config.provider === "anthropic" ? new AnthropicLLM(config) : new OpenAILLM(config);
}

class AnthropicLLM implements LLM {
  constructor(private config: ResolvedConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ maxRetries: MAX_RETRIES });
    const res = await client.messages.create({
      model: this.config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: this.config.temperature,
      system: req.system,
      tools: req.tools.map((t): Tool => ({ name: t.name, description: t.description, input_schema: t.input_schema as unknown as Tool.InputSchema })),
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: req.messages.map(toAnthropic),
    });
    let text = "";
    let toolCall: LlmResponse["toolCall"];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use" && !toolCall) toolCall = { name: block.name, argsRaw: JSON.stringify(block.input) };
    }
    return { text, toolCall, tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens };
  }
}

function toAnthropic(m: ChatMessage): MessageParam {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
  const blocks: ContentBlockParam[] = [];
  if (m.content) blocks.push({ type: "text", text: m.content });
  if (m.toolCall) blocks.push({ type: "tool_use", id: m.toolCall.id, name: m.toolCall.name, input: m.toolCall.args });
  if (blocks.length === 0) blocks.push({ type: "text", text: "(no text)" });
  return { role: "assistant", content: blocks };
}

class OpenAILLM implements LLM {
  constructor(private config: ResolvedConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ maxRetries: MAX_RETRIES });
    const res = await client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      parallel_tool_calls: false,
      tools: req.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema as unknown as Record<string, unknown> },
      })),
      messages: [{ role: "system" as const, content: req.system }, ...req.messages.map(toOpenAI)],
    });
    const msg = res.choices[0]?.message;
    const call = msg?.tool_calls?.[0];
    return {
      text: msg?.content ?? "",
      toolCall: call && call.type === "function" ? { name: call.function.name, argsRaw: call.function.arguments } : undefined,
      tokensIn: res.usage?.prompt_tokens ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    };
  }
}

function toOpenAI(m: ChatMessage) {
  if (m.role === "user") return { role: "user" as const, content: m.content };
  if (m.role === "tool") return { role: "tool" as const, tool_call_id: m.toolCallId, content: m.content };
  if (!m.toolCall) return { role: "assistant" as const, content: m.content };
  return {
    role: "assistant" as const,
    content: m.content || null,
    tool_calls: [
      { id: m.toolCall.id, type: "function" as const, function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.args) } },
    ],
  };
}
