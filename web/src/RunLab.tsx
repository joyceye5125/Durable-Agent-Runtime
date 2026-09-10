import { useCallback, useEffect, useRef, useState } from "react";
import { api, sleep, waitIdle, type CrashTarget, type LedgerRow, type Meta, type Mode, type RunView, type Window } from "./api";

const WINDOW_HELP: Record<Window, string> = {
  W1: "tool chosen, intent not yet logged",
  W2: "intent logged, tool not yet run",
  W3: "tool ran (side effect happened), result not yet logged",
  W4: "result logged, next step not started",
};

type Slots<T> = Partial<Record<Mode, T>>;
type TargetChoice = "next_side_effect" | "next_tool_call" | "page_oncall";

const TARGET_LABEL: Record<TargetChoice, string> = {
  next_side_effect: "next side-effecting call",
  next_tool_call: "next tool call",
  page_oncall: "next page_oncall",
};

function toTarget(t: TargetChoice): CrashTarget {
  return t === "page_oncall" ? { kind: "tool", tool: "page_oncall" } : { kind: t };
}

// The demo crashes on page_oncall because a page leaves no trace a restarted
// agent could observe: a naive restart cannot tell it already happened.
const DEMO_TARGET: CrashTarget = { kind: "tool", tool: "page_oncall" };

export function RunLab({ meta, autoDemo }: { meta: Meta; autoDemo: boolean }) {
  const crashScenarios = meta.scenarios.filter((s) => s.kind === "crash");
  const [scenario, setScenario] = useState(crashScenarios[0]?.id ?? meta.scenarios[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("durable");
  const [window, setWindow] = useState<Window>("W3");
  const [target, setTarget] = useState<TargetChoice>("page_oncall");
  const [ids, setIds] = useState<Slots<string>>({});
  const [views, setViews] = useState<Slots<RunView>>({});
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const autoRan = useRef(false);

  const selected = meta.scenarios.find((s) => s.id === scenario);
  const recorded = selected?.recorded.includes("baseline") ?? false;
  const setView = useCallback((m: Mode) => (v: RunView) => setViews((prev) => ({ ...prev, [m]: v })), []);

  const guard = (fn: () => Promise<void>) => async () => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runDemo = guard(async () => {
    const s = crashScenarios[0]?.id ?? scenario;
    setScenario(s);
    setViews({});
    for (const m of ["durable", "naive"] as Mode[]) {
      setPhase(`${m}: running; crash armed at W3 on page_oncall (the page is sent, the log never hears about it)`);
      const { runId } = await api.startRun({ scenario: s, mode: m, crash: { window: "W3", target: DEMO_TARGET }, paceMs: 200 });
      setIds((prev) => ({ ...prev, [m]: runId }));
      await waitIdle(runId, setView(m));
      setPhase(`${m}: crashed after the side effect ran, before TOOL_COMMITTED was logged. The runtime instance is discarded.`);
      await sleep(1100);
      setPhase(
        m === "durable"
          ? "durable: a new runtime folds the event log and re-invokes the open step with the same idem_key"
          : "naive: no log to recover from, so it runs the whole task again from step 0",
      );
      await api.resume(runId, 90);
      await waitIdle(runId, setView(m));
    }
    setPhase("done: compare the two ledgers — same crash, same model output, different number of side effects");
  });

  const start = guard(async () => {
    setPhase(`${mode}: running — press Crash to inject at ${window} on the ${TARGET_LABEL[target]}`);
    const { runId } = await api.startRun({ scenario, mode, paceMs: 800 });
    setIds((prev) => ({ ...prev, [mode]: runId }));
    setViews((prev) => ({ ...prev, [mode]: undefined }));
    const v = await waitIdle(runId, setView(mode), 150);
    setPhase(v.run.status === "crashed" ? `${mode}: crashed at ${v.crashes.at(-1)?.point.window}. Press Resume.` : `${mode}: ${v.run.status}`);
  });

  const crash = async () => {
    const id = ids[mode];
    if (!id) return;
    try {
      await api.crash(id, window, toTarget(target));
      setPhase(`${mode}: crash armed at ${window}; it fires at the ${TARGET_LABEL[target]}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const resume = guard(async () => {
    const id = ids[mode];
    if (!id) return;
    setPhase(mode === "durable" ? "durable: resuming from the event log" : "naive: restarting from scratch");
    await api.resume(id, 300);
    const v = await waitIdle(id, setView(mode), 150);
    setPhase(`${mode}: ${v.run.status}`);
  });

  useEffect(() => {
    if (autoDemo && recorded && !autoRan.current) {
      autoRan.current = true;
      void runDemo();
    }
  }, [autoDemo, recorded]);

  const current = ids[mode] ? views[mode] : undefined;
  const canCrash = !!current?.executing;
  const canResume = !busy && current?.run.status === "crashed";

  return (
    <section className="section">
      <div className="section-head">
        <h2>One run, crashed in the worst place</h2>
        <p className="muted">
          Every step is logged as <code>TOOL_INVOKED</code> (intent) before the tool runs and <code>TOOL_COMMITTED</code> (result) after.
          W3 is the gap between the two: the side effect already happened, the log doesn't know yet.
        </p>
      </div>

      <div className="windows mono">
        <span>LLM picks tool</span>
        <b className={window === "W1" ? "on" : ""}>W1</b>
        <span>log INVOKED</span>
        <b className={window === "W2" ? "on" : ""}>W2</b>
        <span>run tool → side effect</span>
        <b className={window === "W3" ? "on" : ""}>W3</b>
        <span>log COMMITTED</span>
        <b className={window === "W4" ? "on" : ""}>W4</b>
      </div>

      {!recorded && (
        <div className="notice">
          No baseline recording for <code>{scenario}</code> yet, so there is no model output to replay. Record it once with an API key:{" "}
          <code>{selected?.kind === "crash" ? "npm run record-crash-paths" : `npm run record-golden -- --scenario ${scenario}`}</code> (see README).
        </div>
      )}

      <div className="controls">
        <button className="primary" disabled={busy || !recorded} onClick={runDemo}>
          Run the W3 demo (durable, then naive)
        </button>
        <span className="sep" />
        <label>
          scenario
          <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={busy}>
            {meta.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          mode
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy}>
            <option value="durable">durable</option>
            <option value="naive">naive</option>
          </select>
        </label>
        <label>
          window
          <select value={window} onChange={(e) => setWindow(e.target.value as Window)} title={WINDOW_HELP[window]}>
            {(["W1", "W2", "W3", "W4"] as Window[]).map((w) => (
              <option key={w} value={w}>
                {w} · {WINDOW_HELP[w]}
              </option>
            ))}
          </select>
        </label>
        <label>
          at
          <select value={target} onChange={(e) => setTarget(e.target.value as TargetChoice)}>
            {(Object.keys(TARGET_LABEL) as TargetChoice[]).map((t) => (
              <option key={t} value={t}>
                {TARGET_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !recorded} onClick={start}>
          Start
        </button>
        <button disabled={!canCrash} onClick={crash}>
          Crash
        </button>
        <button disabled={!canResume} onClick={resume}>
          Resume
        </button>
      </div>
      {(phase || error) && <div className={`phase mono ${error ? "err" : ""}`}>{error || phase}</div>}

      <div className="panels">
        {(["durable", "naive"] as Mode[]).map((m) => (
          <RunPanel key={m} mode={m} view={ids[m] ? views[m] : undefined} />
        ))}
      </div>
    </section>
  );
}

const MODE_TITLE: Record<Mode, string> = {
  durable: "durable · resumes from the event log, side effects keyed by idem_key",
  naive: "naive baseline · restarts from scratch, no idempotency ledger",
};

function RunPanel({ mode, view }: { mode: Mode; view?: RunView }) {
  return (
    <div className={`panel ${mode}`}>
      <div className="panel-head">
        <span className="mode">{MODE_TITLE[mode]}</span>
        {view && (
          <span className="mono muted">
            {view.run.id} · <Status s={view.executing ? "running" : view.run.status} />
          </span>
        )}
      </div>
      {!view ? (
        <div className="empty muted">no run yet</div>
      ) : (
        <div className="panel-body">
          <Timeline view={view} />
          <Ledger view={view} />
        </div>
      )}
    </div>
  );
}

function Status({ s }: { s: string }) {
  return <span className={`pill ${s}`}>{s}</span>;
}

type Chip = { label: string; cls: string; title?: string };
type Row =
  | { type: "step"; key: string; step: number; call: string; chips: Chip[]; note?: string }
  | { type: "marker"; key: string; text: string; cls: string };

function buildTimeline(view: RunView): Row[] {
  const rows: Row[] = [];
  const byKey = new Map<string, Extract<Row, { type: "step" }>>();
  let attempt = 0;
  let resumePending = false;
  const group = (step: number) => {
    const key = `${attempt}:${step}`;
    let g = byKey.get(key);
    if (!g) {
      g = { type: "step", key, step, call: "", chips: [] };
      byKey.set(key, g);
      rows.push(g);
    }
    if (resumePending) {
      g.chips.push({ label: "RESUME", cls: "resume", title: "new Runtime, state folded from the log" });
      resumePending = false;
    }
    return g;
  };
  for (const e of view.events) {
    const d = e.data as Record<string, any>;
    switch (e.kind) {
      case "RUN_STARTED":
        attempt++;
        if (d.restart) {
          resumePending = false;
          rows.push({ type: "marker", key: `restart-${e.seq}`, text: `RESTART · attempt ${attempt}: the naive baseline re-runs the task from step 0`, cls: "restart" });
        }
        break;
      case "LLM_RESPONDED": {
        const g = group(e.step);
        g.chips.push({ label: "LLM", cls: "llm" });
        g.call = d.is_final ? "final answer" : `${d.tool_name ?? "?"}(${compactArgs(d.tool_args)})`;
        break;
      }
      case "TOOL_INVOKED":
        group(e.step).chips.push({ label: "INTENT", cls: "intent", title: `idem_key ${String(d.idem_key).slice(0, 12)}` });
        break;
      case "TOOL_COMMITTED":
        group(e.step).chips.push({ label: "COMMITTED", cls: "committed" });
        break;
      case "TOOL_REJECTED": {
        const g = group(e.step);
        g.chips.push({ label: "REJECTED", cls: "rejected" });
        g.note = String(d.reason);
        break;
      }
      case "TOOL_FAILED": {
        const g = group(e.step);
        g.chips.push({ label: "FAILED", cls: "failed" });
        g.note = String(d.error);
        break;
      }
      case "RUN_COMPLETED":
        rows.push({ type: "marker", key: `done-${e.seq}`, text: `COMPLETED · ${d.final_answer}`, cls: "done" });
        break;
      case "RUN_FAILED":
        rows.push({ type: "marker", key: `fail-${e.seq}`, text: `FAILED · ${d.error}`, cls: "failmark" });
        break;
    }
    for (const c of view.crashes.filter((x) => x.afterSeq === e.seq)) {
      const last = rows[rows.length - 1];
      const chip = { label: `CRASH ${c.point.window}`, cls: "crash", title: "runtime instance discarded" };
      if (last?.type === "step") last.chips.push(chip);
      else rows.push({ type: "marker", key: `crash-${e.seq}`, text: `CRASH ${c.point.window}`, cls: "crash" });
      if (view.run.mode === "durable") resumePending = true;
    }
  }
  return rows;
}

function compactArgs(raw: unknown): string {
  try {
    const obj = JSON.parse(String(raw ?? "{}"));
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
  } catch {
    return String(raw);
  }
}

function Timeline({ view }: { view: RunView }) {
  const rows = buildTimeline(view);
  return (
    <div className="timeline">
      <div className="col-title">step timeline</div>
      {rows.map((r) =>
        r.type === "marker" ? (
          <div key={r.key} className={`marker ${r.cls}`}>
            {r.text}
          </div>
        ) : (
          <div key={r.key} className="step">
            <span className="n mono">{String(r.step).padStart(2, "0")}</span>
            <span className="call mono">{r.call}</span>
            <span className="chips">
              {r.chips.map((c, i) => (
                <span key={i} className={`chip ${c.cls}`} title={c.title}>
                  {c.label}
                </span>
              ))}
            </span>
            {r.note && <span className="note mono">{r.note}</span>}
          </div>
        ),
      )}
    </div>
  );
}

function Ledger({ view }: { view: RunView }) {
  // A W3 crash lands after the ledger insert: that row predates the crash,
  // and the resumed runtime's re-invocation hit ON CONFLICT instead of adding one.
  const survivedSteps = new Set(
    view.run.mode === "durable" ? view.crashes.filter((c) => c.point.window === "W3").map((c) => c.point.step) : [],
  );
  const seen = new Set<string>();
  const rows = view.ledger.map((r: LedgerRow) => {
    const k = `${r.tool}|${r.idem_key ?? r.args_hash}`;
    const dup = seen.has(k);
    seen.add(k);
    return { ...r, dup };
  });
  const dups = rows.filter((r) => r.dup).length;
  return (
    <div className="ledger">
      <div className="col-title">
        side-effect ledger <span className="muted">({view.run.mode === "durable" ? "side_effects" : "naive_side_effects"})</span>
      </div>
      <div className="count mono">
        <b>{rows.length}</b> rows{dups > 0 && <span className="dupcount"> · {dups} duplicate{dups > 1 ? "s" : ""}</span>}
      </div>
      <table className="mono">
        <thead>
          <tr>
            <th>step</th>
            <th>tool</th>
            <th>args</th>
            <th>{view.run.mode === "durable" ? "idem_key" : "args_hash"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.dup ? "dup" : ""}>
              <td>{r.step}</td>
              <td>{r.tool}</td>
              <td className="args">{compactArgs(JSON.stringify(r.args))}</td>
              <td>
                {(r.idem_key ?? r.args_hash ?? "").slice(0, 10)}
                {r.dup && <span className="duptag"> DUPLICATE</span>}
                {survivedSteps.has(r.step) && <span className="kept"> pre-crash row · resume hit ON CONFLICT</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
