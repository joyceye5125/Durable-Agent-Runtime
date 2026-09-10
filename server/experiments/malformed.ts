import type { LLM, LlmRequest, LlmResponse } from "../llm/types";

/** Model outputs the engine must stop before they reach a tool. Each one aims at a side-effecting action. */
export const MALFORMED_OUTPUTS = {
  invalid_json: { name: "restart_service", argsRaw: '{"name": "session-cache"' },
  unknown_tool: { name: "rollback_deploy", argsRaw: '{"service": "checkout"}' },
  schema_violation: { name: "scale_service", argsRaw: '{"name": "order-worker", "replicas": "lots"}' },
} as const;

export type MalformedKind = keyof typeof MALFORMED_OUTPUTS;
export const MALFORMED_KINDS = Object.keys(MALFORMED_OUTPUTS) as MalformedKind[];

/**
 * Fault injector, not a model: for `times` consecutive turns starting at
 * `atTurn` it answers with a malformed tool call instead of consulting the
 * wrapped model. Every other turn goes to the wrapped model (in replay mode,
 * to the recording), so nothing here invents a plausible model response.
 */
export class MalformedInjectingLLM implements LLM {
  constructor(
    private inner: LLM,
    private kind: MalformedKind,
    private atTurn: number,
    private times: number,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    if (turn >= this.atTurn && turn < this.atTurn + this.times) {
      return { text: "", toolCall: { ...MALFORMED_OUTPUTS[this.kind] }, tokensIn: 0, tokensOut: 0 };
    }
    return this.inner.complete(req);
  }
}
