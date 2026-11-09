import { fold, trajectoryOf } from "../core/events";
import { CONFIGS } from "../llm/configs";
import { hasRecording } from "../llm/recording";
import { buildRuntime, createRun, defaultAgentFactory, type AgentFactory } from "../runtime/runs";
import { listScenarioIds, loadScenario, type Scenario } from "../scenarios";
import { goldenIsUsable } from "./golden";
import type { EvalResultRow, Store } from "../store/store";
import { scoreTrajectory, type ProcessRule, type TrajectoryScore } from "./trajectory";

export interface ChangeResult {
  label: string;
  description: string;
  status: "evaluated" | "not_recorded" | "error";
  missing?: string[];
  error?: string;
  evalRunId?: number;
  endpointPass?: number;
  total?: number;
  /** Tasks the process rules flag: endpoint failures plus broken requirements. */
  trajFlagged?: number;
  /** Tasks that completed but broke a stated requirement. */
  violationRows?: number;
  /** Tasks that completed, broke no requirement, and still took a different path. */
  divergedRows?: number;
  /** Which requirements were broken, and how often. */
  violationCounts?: Record<string, number>;
  meanEditDist?: number;
  extraCalls?: number;
  wrongRecover?: number;
  endpointVerdict?: "PASS" | "BLOCKED";
  trajectoryVerdict?: "PASS" | "NEEDS_REVIEW" | "BLOCKED";
  rows?: Array<{ task: string } & TrajectoryScore & { tokens: number }>;
}

export interface EvalSummary {
  tasks: string[];
  tasksWithoutGolden: string[];
  changes: ChangeResult[];
  /** Candidate changes that completed every task and still broke a stated requirement. */
  missedByEndpoint: number;
  /** Runs that completed the task and broke a requirement. */
  violationRows: number;
  /** Runs that completed the task, broke nothing, and took a different path. */
  divergedRows: number;
  /** Tasks whose golden trajectory is still a provisional prediction, not a reviewed baseline run. */
  provisionalGolden: string[];
}

/**
 * Divergence replay over the task set: every (config, task) runs against the
 * same deterministic tools, so any difference from the golden path is caused
 * by the config change alone.
 */
export async function runEvalExperiment(
  store: Store,
  opts: { labels?: string[]; agent?: AgentFactory; tasks?: Scenario[] } = {},
): Promise<EvalSummary> {
  const agent = opts.agent ?? defaultAgentFactory();
  const all = opts.tasks ?? listScenarioIds("eval").map(loadScenario);
  // Only a golden that is a measurement counts: reviewed, from this scenario,
  // from this baseline. A caller that brings its own agent brings its own
  // scenarios too, and has no recordings for them to check against.
  const usable = opts.agent ? (s: Scenario) => !!s.golden_trajectory?.length : goldenIsUsable;
  const tasks = all.filter(usable);
  const labels = opts.labels ?? CONFIGS.map((c) => c.label);
  const changes: ChangeResult[] = [];

  for (const label of labels) {
    const cfg = CONFIGS.find((c) => c.label === label);
    if (!cfg) throw new Error(`unknown config "${label}"`);
    const base: ChangeResult = { label, description: cfg.description, status: "evaluated" };
    const missing = opts.agent ? [] : tasks.filter((t) => !hasRecording(label, t.id)).map((t) => t.id);
    if (tasks.length === 0 || missing.length > 0) {
      changes.push({ ...base, status: "not_recorded", missing: tasks.length === 0 ? [] : missing });
      continue;
    }
    // A run whose recording was cut short (the recorder died mid-run) replays
    // fine until the turn it stopped at. Collect every task that does it, so
    // one free pass says exactly what is missing instead of the first one.
    const rows = [];
    const truncated: string[] = [];
    for (const task of tasks) {
      try {
        rows.push({ task: task.id, ...(await evaluateTask(store, agent, label, task)) });
      } catch (e) {
        truncated.push(`${task.id} (${(e as Error).message.match(/turn (\d+)/)?.[0] ?? "diverged"})`);
      }
    }
    if (truncated.length) {
      changes.push({ ...base, status: "error", error: `recording incomplete for ${truncated.length}/${tasks.length} tasks: ${truncated.join(", ")}` });
      continue;
    }
    try {
      const endpointPass = rows.filter((r) => r.endpoint_ok).length;
      const violationRows = rows.filter((r) => r.endpoint_ok && r.violations.length > 0).length;
      const divergedRows = rows.filter((r) => r.endpoint_ok && r.violations.length === 0 && r.diverged).length;
      const trajFlagged = rows.filter((r) => r.verdict === "BLOCKED").length;
      const violationCounts: Record<string, number> = {};
      for (const r of rows) for (const v of r.violations) violationCounts[v] = (violationCounts[v] ?? 0) + 1;
      // Divergence on its own is not a verdict: it asks for a human, it does not block.
      const trajectoryVerdict = trajFlagged > 0 ? "BLOCKED" : divergedRows > 0 ? "NEEDS_REVIEW" : "PASS";
      const dbRows: Omit<EvalResultRow, "eval_run_id">[] = rows.map((r) => ({
        task_id: r.task,
        endpoint_ok: r.endpoint_ok,
        path_exact: r.path_exact,
        edit_dist: r.edit_dist,
        extra_calls: r.extra_calls,
        wrong_recover: r.wrong_recover,
        violations: r.violations.join(","),
        tokens: r.tokens,
      }));
      const evalRunId = await store.insertEvalRun(
        { change_label: label, endpoint_pass: endpointPass, endpoint_total: rows.length, traj_flagged: trajFlagged, verdict: trajectoryVerdict },
        dbRows,
      );
      changes.push({
        ...base,
        evalRunId,
        endpointPass,
        total: rows.length,
        trajFlagged,
        violationRows,
        divergedRows,
        violationCounts,
        meanEditDist: rows.reduce((s, r) => s + r.edit_dist, 0) / rows.length,
        extraCalls: rows.reduce((s, r) => s + r.extra_calls, 0),
        wrongRecover: rows.filter((r) => r.wrong_recover).length,
        endpointVerdict: endpointPass === rows.length ? "PASS" : "BLOCKED",
        trajectoryVerdict,
        rows,
      });
    } catch (e) {
      changes.push({ ...base, status: "error", error: (e as Error).message });
    }
  }

  const candidates = changes.filter((c) => c.label !== "baseline" && c.status === "evaluated");
  return {
    tasks: tasks.map((t) => t.id),
    tasksWithoutGolden: all.filter((s) => !usable(s)).map((s) => s.id),
    changes,
    missedByEndpoint: candidates.filter((c) => c.endpointVerdict === "PASS" && c.trajectoryVerdict === "BLOCKED").length,
    violationRows: candidates.reduce((s, c) => s + (c.violationRows ?? 0), 0),
    divergedRows: candidates.reduce((s, c) => s + (c.divergedRows ?? 0), 0),
    provisionalGolden: tasks.filter((t) => !usable(t)).map((t) => t.id),
  };
}

async function evaluateTask(store: Store, agent: AgentFactory, label: string, task: Scenario) {
  const runId = await createRun(store, { scenario: task.id, mode: "durable", configLabel: label }, { agent });
  const out = await (await buildRuntime(store, runId, { agent })).drive();
  if (out.status === "failed" && /no recorded response|has not been recorded|changed since/.test(out.error)) {
    throw new Error(`${task.id}: ${out.error}`);
  }
  const state = fold(await store.listEvents(runId));
  const calls = trajectoryOf(state).map((c) => ({ tool: c.tool, args: c.args, outcome: c.outcome }));
  const score = scoreTrajectory(task, {
    status: state.status,
    finalAnswer: state.finalAnswer,
    calls,
    ledger: await store.listSideEffects(runId),
  });
  return { ...score, tokens: state.tokensIn + state.tokensOut };
}

/** Rebuilds the comparison table from the latest persisted eval run of every config. */
export async function latestEvalTable(store: Store): Promise<EvalSummary & { evaluatedAt?: string }> {
  const all = listScenarioIds("eval").map(loadScenario);
  // Only a golden that is a measurement counts: reviewed, from this scenario, from this baseline.
  const tasks = all.filter(goldenIsUsable);
  const latest = new Map<string, Awaited<ReturnType<Store["listEvalRuns"]>>[number]>();
  for (const r of await store.listEvalRuns(1000)) if (!latest.has(r.change_label)) latest.set(r.change_label, r);
  const results = await store.listEvalResults([...latest.values()].map((r) => r.id));

  const changes: ChangeResult[] = CONFIGS.map((cfg) => {
    const run = latest.get(cfg.label);
    if (!run) {
      const missing = tasks.filter((t) => !hasRecording(cfg.label, t.id)).map((t) => t.id);
      // No eval run and nothing missing means the recordings are there but one
      // of them stops early; the last eval says which.
      return {
        label: cfg.label,
        description: cfg.description,
        status: missing.length ? "not_recorded" : "error",
        missing,
        error: missing.length ? undefined : "a recording stops before the run does; re-record this config",
      };
    }
    const rows = results
      .filter((r) => r.eval_run_id === run.id)
      .map((r) => {
        const violations = r.violations ? (r.violations.split(",") as ProcessRule[]) : [];
        const diverged = !r.path_exact;
        return {
          task: r.task_id,
          ...r,
          violations,
          diverged,
          verdict: (!r.endpoint_ok || violations.length ? "BLOCKED" : diverged ? "NEEDS_REVIEW" : "PASS") as TrajectoryScore["verdict"],
        };
      });
    return {
      label: cfg.label,
      description: cfg.description,
      status: "evaluated",
      evalRunId: run.id,
      endpointPass: run.endpoint_pass,
      total: run.endpoint_total,
      trajFlagged: run.traj_flagged,
      violationRows: rows.filter((r) => r.endpoint_ok && r.violations.length > 0).length,
      divergedRows: rows.filter((r) => r.endpoint_ok && r.violations.length === 0 && r.diverged).length,
      violationCounts: rows.reduce<Record<string, number>>((acc, r) => {
        for (const v of r.violations) acc[v] = (acc[v] ?? 0) + 1;
        return acc;
      }, {}),
      meanEditDist: rows.length ? rows.reduce((s, r) => s + r.edit_dist, 0) / rows.length : 0,
      extraCalls: rows.reduce((s, r) => s + r.extra_calls, 0),
      wrongRecover: rows.filter((r) => r.wrong_recover).length,
      endpointVerdict: run.endpoint_pass === run.endpoint_total ? "PASS" : "BLOCKED",
      trajectoryVerdict: run.verdict,
      rows,
    };
  });
  const candidates = changes.filter((c) => c.label !== "baseline" && c.status === "evaluated");
  const evaluatedAt = [...latest.values()].map((r) => r.started_at).sort().at(-1);
  return {
    tasks: tasks.map((t) => t.id),
    tasksWithoutGolden: all.filter((s) => !goldenIsUsable(s)).map((s) => s.id),
    changes,
    missedByEndpoint: candidates.filter((c) => c.endpointVerdict === "PASS" && c.trajectoryVerdict === "BLOCKED").length,
    violationRows: candidates.reduce((s, c) => s + (c.violationRows ?? 0), 0),
    divergedRows: candidates.reduce((s, c) => s + (c.divergedRows ?? 0), 0),
    provisionalGolden: tasks.filter((t) => !goldenIsUsable(t)).map((t) => t.id),
    evaluatedAt,
  };
}
