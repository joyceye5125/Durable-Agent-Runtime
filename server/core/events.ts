export type RunMode = "durable" | "naive";

export interface EventPayloads {
  RUN_STARTED: { scenario: string; config_label: string; config_hash: string; mode: RunMode; restart?: boolean };
  LLM_RESPONDED: {
    step: number;
    response: string;
    tool_name?: string;
    /** Raw argument string exactly as the model produced it — may be invalid JSON. */
    tool_args?: string;
    is_final: boolean;
    tokens_in: number;
    tokens_out: number;
  };
  TOOL_INVOKED: { step: number; tool_name: string; args: Record<string, unknown>; idem_key: string };
  TOOL_COMMITTED: { step: number; result: unknown };
  TOOL_REJECTED: { step: number; reason: string };
  TOOL_FAILED: { step: number; error: string };
  RUN_COMPLETED: { final_answer: string };
  RUN_FAILED: { error: string };
}

export type EventKind = keyof EventPayloads;

export type RunEvent = {
  [K in EventKind]: { run_id: string; seq: number; step: number; kind: K; data: EventPayloads[K]; ts?: string };
}[EventKind];

export type NewEvent = { [K in EventKind]: { step: number; kind: K; data: EventPayloads[K] } }[EventKind];

export interface StepRecord {
  step: number;
  llm?: EventPayloads["LLM_RESPONDED"];
  invoked?: EventPayloads["TOOL_INVOKED"];
  outcome?:
    | { kind: "committed"; result: unknown }
    | { kind: "rejected"; reason: string }
    | { kind: "failed"; error: string };
}

export interface RunState {
  scenario: string;
  configLabel: string;
  configHash: string;
  mode: RunMode;
  status: "running" | "completed" | "failed";
  /** Steps of the current attempt. A naive restart begins a new, empty attempt. */
  steps: StepRecord[];
  attempts: number;
  finalAnswer?: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
}

export function emptyState(): RunState {
  return {
    scenario: "",
    configLabel: "",
    configHash: "",
    mode: "durable",
    status: "running",
    steps: [],
    attempts: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
}

/**
 * Pure reducer. The run's state is *defined* as fold(apply, events); the
 * runtime keeps nothing else, which is what makes resume after a crash and
 * faithful replay the same operation as normal execution.
 */
export function apply(state: RunState, e: NewEvent | RunEvent): RunState {
  const s: RunState = { ...state, steps: state.steps.slice() };
  const stepAt = (n: number): StepRecord => {
    const existing = s.steps[n];
    const copy: StepRecord = existing ? { ...existing } : { step: n };
    s.steps[n] = copy;
    return copy;
  };
  switch (e.kind) {
    case "RUN_STARTED":
      s.scenario = e.data.scenario;
      s.configLabel = e.data.config_label;
      s.configHash = e.data.config_hash;
      s.mode = e.data.mode;
      s.status = "running";
      s.steps = [];
      s.attempts += 1;
      s.finalAnswer = undefined;
      s.error = undefined;
      break;
    case "LLM_RESPONDED":
      stepAt(e.data.step).llm = e.data;
      s.tokensIn += e.data.tokens_in;
      s.tokensOut += e.data.tokens_out;
      break;
    case "TOOL_INVOKED":
      stepAt(e.data.step).invoked = e.data;
      break;
    case "TOOL_COMMITTED":
      stepAt(e.data.step).outcome = { kind: "committed", result: e.data.result };
      break;
    case "TOOL_REJECTED":
      stepAt(e.data.step).outcome = { kind: "rejected", reason: e.data.reason };
      break;
    case "TOOL_FAILED":
      stepAt(e.data.step).outcome = { kind: "failed", error: e.data.error };
      break;
    case "RUN_COMPLETED":
      s.status = "completed";
      s.finalAnswer = e.data.final_answer;
      break;
    case "RUN_FAILED":
      s.status = "failed";
      s.error = e.data.error;
      break;
  }
  return s;
}

export function fold(events: Array<NewEvent | RunEvent>): RunState {
  return events.reduce(apply, emptyState());
}

/** Number of consecutive rejected steps at the tail of the current attempt. */
export function invalidStreak(state: RunState): number {
  let n = 0;
  for (let i = state.steps.length - 1; i >= 0; i--) {
    if (state.steps[i]?.outcome?.kind === "rejected") n++;
    else break;
  }
  return n;
}

export type NextAction =
  | { kind: "done" }
  | { kind: "call_llm"; step: number }
  /** LLM response is logged but its tool call was never dispatched (crash in W1). */
  | { kind: "dispatch"; step: number }
  /** TOOL_INVOKED is logged but no outcome (crash in W2/W3): re-run with the same idem_key. */
  | { kind: "reinvoke"; step: number }
  /** A final answer is logged but RUN_COMPLETED is not. */
  | { kind: "complete"; step: number };

export function nextAction(state: RunState): NextAction {
  if (state.status !== "running") return { kind: "done" };
  const last = state.steps[state.steps.length - 1];
  if (!last) return { kind: "call_llm", step: 0 };
  if (last.outcome) return { kind: "call_llm", step: last.step + 1 };
  if (last.invoked) return { kind: "reinvoke", step: last.step };
  if (last.llm?.is_final) return { kind: "complete", step: last.step };
  if (last.llm) return { kind: "dispatch", step: last.step };
  return { kind: "call_llm", step: last.step };
}

export interface TrajectoryCall {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  outcome: "committed" | "failed" | "pending";
}

/** Executed (validated) tool calls of the current attempt, in order. Rejected calls never ran, so they are not part of the path. */
export function trajectoryOf(state: RunState): TrajectoryCall[] {
  const out: TrajectoryCall[] = [];
  for (const st of state.steps) {
    if (!st?.invoked) continue;
    out.push({
      step: st.step,
      tool: st.invoked.tool_name,
      args: st.invoked.args,
      outcome: st.outcome?.kind === "failed" ? "failed" : st.outcome ? "committed" : "pending",
    });
  }
  return out;
}
