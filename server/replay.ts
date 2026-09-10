import { canonicalJSON } from "./core/canonical";
import { fold, trajectoryOf, type NewEvent, type RunEvent, type TrajectoryCall } from "./core/events";
import { resolveConfig, type Provider } from "./llm/configs";
import type { LLM, LlmResponse } from "./llm/types";
import type { ToolExecutor, ToolOutcome } from "./runtime/executor";
import { Runtime } from "./runtime/runtime";
import type { Scenario } from "./scenarios";

class LogExhausted extends Error {}

export interface FaithfulReplay {
  trajectory: TrajectoryCall[];
  finalAnswer?: string;
  /** The re-driven loop produced exactly the logged events (ignoring seq/ts). */
  identical: boolean;
  /** The log ends before a terminal event (e.g. a crashed run not yet resumed). */
  partial: boolean;
  eventsCompared: number;
  firstDifference?: { index: number; expected: string; got: string };
}

/**
 * Re-drives the real agent loop with model output and tool results taken
 * from the log: no model is called and no tool runs. If the loop is a pure
 * function of those inputs, it must reproduce the log event for event.
 */
export async function faithfulReplay(allEvents: RunEvent[], scenario: Scenario): Promise<FaithfulReplay> {
  // A naive run may contain several attempts; replay the last one.
  const start = allEvents.map((e) => e.kind).lastIndexOf("RUN_STARTED");
  const original = allEvents.slice(start);
  const header = original[0];
  if (!header || header.kind !== "RUN_STARTED") throw new Error("run has no RUN_STARTED event");

  const responses = original.filter((e) => e.kind === "LLM_RESPONDED");
  const llm: LLM = {
    async complete(): Promise<LlmResponse> {
      const e = responses.shift();
      if (!e) throw new LogExhausted();
      return {
        text: e.data.response,
        toolCall: e.data.tool_name !== undefined ? { name: e.data.tool_name, argsRaw: e.data.tool_args ?? "" } : undefined,
        tokensIn: e.data.tokens_in,
        tokensOut: e.data.tokens_out,
      };
    },
  };
  const tools: ToolExecutor = {
    async invoke(call): Promise<ToolOutcome> {
      const e = original.find((x) => (x.kind === "TOOL_COMMITTED" || x.kind === "TOOL_FAILED") && x.step === call.step);
      if (!e) throw new LogExhausted();
      return e.kind === "TOOL_COMMITTED" ? { ok: true, result: e.data.result } : { ok: false, error: (e.data as { error: string }).error };
    },
  };

  const produced: NewEvent[] = [{ step: header.step, kind: "RUN_STARTED", data: header.data }];
  // Model output comes from the log, so only the loop's limits matter here;
  // the stored hash is carried over so the runtime's config check passes.
  const base = resolveConfig(header.data.config_label, "anthropic" as Provider);
  const runtime = new Runtime({
    runId: header.run_id,
    sink: { load: async () => produced.slice(), append: async (e) => void produced.push(e), setStatus: async () => {} },
    llm,
    tools,
    config: { ...base, hash: header.data.config_hash },
    scenario,
  });
  try {
    await runtime.drive();
  } catch (e) {
    if (!(e instanceof LogExhausted)) throw e;
  }

  const terminal = original.some((e) => e.kind === "RUN_COMPLETED" || e.kind === "RUN_FAILED");
  const key = (e: NewEvent | RunEvent) => `${e.kind}@${e.step} ${canonicalJSON(e.data)}`;
  // A log that ends mid-run makes the replay stop with "end of log"; compare the logged prefix only.
  const got = terminal ? produced : produced.slice(0, original.length);
  let firstDifference: FaithfulReplay["firstDifference"];
  const len = Math.max(original.length, got.length);
  for (let i = 0; i < len; i++) {
    const a = original[i] ? key(original[i]) : "<none>";
    const b = got[i] ? key(got[i]) : "<none>";
    if (a !== b) {
      firstDifference = { index: i, expected: a, got: b };
      break;
    }
  }
  const state = fold(got);
  return {
    trajectory: trajectoryOf(state),
    finalAnswer: state.finalAnswer,
    identical: !firstDifference,
    partial: !terminal,
    eventsCompared: original.length,
    firstDifference,
  };
}
