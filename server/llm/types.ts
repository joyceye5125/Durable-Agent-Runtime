import type { StepRecord } from "../core/events";
import type { ToolSpec } from "../tools/registry";

/** Provider-neutral conversation format. Both SDK adapters translate from this. */
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCall?: { id: string; name: string; args: Record<string, unknown> } }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface LlmResponse {
  text: string;
  toolCall?: { name: string; argsRaw: string };
  tokensIn: number;
  tokensOut: number;
}

export interface LLM {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Rebuilds the conversation purely from logged steps. Call ids are derived
 * from the step number (not the provider's ids) so the same log always yields
 * byte-identical requests — which is what recording lookup keys on.
 */
export function buildMessages(task: string, steps: StepRecord[]): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "user", content: task }];
  for (const st of steps) {
    if (!st?.llm) continue;
    const { llm } = st;
    if (st.outcome?.kind === "rejected") {
      // Rejected calls are replayed as plain text, not as tool_use blocks:
      // providers refuse histories containing calls to undeclared tools or
      // non-object arguments, and the model only needs to see what it tried.
      const attempted = `[invalid tool call] ${llm.tool_name ?? "<none>"}(${llm.tool_args ?? ""})`;
      msgs.push({ role: "assistant", content: [llm.response, attempted].filter(Boolean).join("\n") });
      msgs.push({ role: "user", content: `Tool call rejected before execution: ${st.outcome.reason}` });
      continue;
    }
    if (!llm.tool_name || llm.is_final) {
      msgs.push({ role: "assistant", content: llm.response });
      continue;
    }
    const id = `call_${st.step}`;
    msgs.push({
      role: "assistant",
      content: llm.response,
      toolCall: { id, name: llm.tool_name, args: st.invoked?.args ?? JSON.parse(llm.tool_args || "{}") },
    });
    if (st.outcome?.kind === "committed") {
      msgs.push({ role: "tool", toolCallId: id, content: JSON.stringify(st.outcome.result) });
    } else if (st.outcome?.kind === "failed") {
      msgs.push({ role: "tool", toolCallId: id, content: `ERROR: ${st.outcome.error}` });
    }
  }
  return msgs;
}
