export type Mode = "durable" | "naive";
export type Window = "W1" | "W2" | "W3" | "W4";
export type CrashTarget =
  | { kind: "next_side_effect" }
  | { kind: "next_tool_call" }
  | { kind: "tool_call"; index: number }
  | { kind: "tool"; tool: string };

export interface Meta {
  llmMode: "replay" | "live";
  db: "postgres" | "sqlite";
  windows: Window[];
  scenarios: Array<{ id: string; kind: "eval" | "crash"; task: string; hasGolden: boolean; recorded: string[] }>;
  configs: Array<{ label: string; description: string }>;
}

export interface RunEvent {
  seq: number;
  step: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface LedgerRow {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  idem_key?: string;
  args_hash?: string;
  id?: number;
}

export interface RunView {
  run: { id: string; scenario: string; mode: Mode; config_label: string; status: string };
  executing: boolean;
  crashes: Array<{ afterSeq: number; point: { window: Window; step: number; tool: string } }>;
  state: { status: string; attempts: number; finalAnswer?: string; error?: string; tokens: number; next: { kind: string; step?: number } };
  events: RunEvent[];
  ledger: LedgerRow[];
}

export interface EvalRow {
  task: string;
  endpoint_ok: boolean;
  path_exact: boolean;
  edit_dist: number;
  extra_calls: number;
  wrong_recover: boolean;
  path_regressed: boolean;
  tokens: number;
}

export interface ChangeResult {
  label: string;
  description: string;
  status: "evaluated" | "not_recorded" | "error";
  missing?: string[];
  endpointPass?: number;
  total?: number;
  pathOnlyRegressions?: number;
  meanEditDist?: number;
  extraCalls?: number;
  wrongRecover?: number;
  endpointVerdict?: "PASS" | "BLOCKED";
  trajectoryVerdict?: "PASS" | "BLOCKED";
  rows?: EvalRow[];
}

export interface EvalTable {
  tasks: string[];
  tasksWithoutGolden: string[];
  changes: ChangeResult[];
  missedByEndpoint: number;
  pathOnlyRows: number;
  provisionalGolden: string[];
  evaluatedAt?: string;
}

export interface CrashSummary {
  scenario: string;
  n: number;
  seed: number;
  reference: { steps: number; toolCalls: number; sideEffects: number };
  durable: { trials: number; correct: number; correctPct: number; duplicateSideEffects: number };
  naive: {
    trials: number;
    measured: number;
    unrecorded: number;
    exposed: number;
    trialsWithDuplicates: number;
    duplicateRatePct: number | null;
    duplicateRateWhenExposedPct: number | null;
    duplicateRows: number;
  };
  malformed: { cases: Array<{ kind: string; variant: string; status: string; rejected: number }>; allBlocked: boolean };
}

export interface Results {
  crash: Array<{ id: number; started_at: string; summary: CrashSummary }>;
  eval: EvalTable;
  /** The server is computing first results from the recordings after boot. */
  seeding: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  meta: () => call<Meta>("GET", "/api/meta"),
  startRun: (b: { scenario: string; mode: Mode; crash?: { window: Window; target: CrashTarget }; paceMs?: number }) =>
    call<{ runId: string }>("POST", "/api/runs", b),
  crash: (id: string, window: Window, target: CrashTarget) => call("POST", `/api/runs/${id}/crash`, { window, target }),
  resume: (id: string, paceMs?: number) => call("POST", `/api/runs/${id}/resume`, { paceMs }),
  run: (id: string) => call<RunView>("GET", `/api/runs/${id}`),
  results: () => call<Results>("GET", "/api/experiments/results"),
  runCrashExperiment: (n: number) => call<{ summary: CrashSummary }>("POST", "/api/experiments/crash", { n }),
  runEval: () => call<{ errors: Array<{ label: string; error: string }>; table: EvalTable }>("POST", "/api/experiments/eval", {}),
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the run has stopped executing (finished or crashed). */
export async function waitIdle(id: string, onView: (v: RunView) => void, intervalMs = 200): Promise<RunView> {
  for (;;) {
    const v = await api.run(id);
    onView(v);
    if (!v.executing) return v;
    await sleep(intervalMs);
  }
}
