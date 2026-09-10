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
  results: () => call<Record<string, unknown>>("GET", "/api/experiments/results"),
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
