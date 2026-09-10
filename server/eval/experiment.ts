import { fold, trajectoryOf } from "../core/events";
import { CONFIGS } from "../llm/configs";
import { hasRecording } from "../llm/recording";
import { buildRuntime, createRun, defaultAgentFactory, type AgentFactory } from "../runtime/runs";
import { listScenarioIds, loadScenario, type Scenario } from "../scenarios";
import type { EvalResultRow, Store } from "../store/store";
import { scoreTrajectory, type TrajectoryScore } from "./trajectory";

export interface ChangeResult {
  label: string;
  description: string;
  status: "evaluated" | "not_recorded" | "error";
  missing?: string[];
  error?: string;
  evalRunId?: number;
  endpointPass?: number;
  total?: number;
  /** Tasks the trajectory eval flags: endpoint failures plus path regressions. */
  trajFlagged?: number;
  /** Tasks whose endpoint is correct but whose path regressed. */
  pathOnlyRegressions?: number;
  meanEditDist?: number;
  extraCalls?: number;
  wrongRecover?: number;
  endpointVerdict?: "PASS" | "BLOCKED";
  trajectoryVerdict?: "PASS" | "BLOCKED";
  rows?: Array<{ task: string } & TrajectoryScore & { tokens: number }>;
}

export interface EvalSummary {
  tasks: string[];
  tasksWithoutGolden: string[];
  changes: ChangeResult[];
  /** Candidate changes whose endpoint eval passes but whose trajectory eval blocks. */
  missedByEndpoint: number;
  /** Rows with endpoint_ok and a regressed path (the completion criterion counts these). */
  pathOnlyRows: number;
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
  const tasks = all.filter((s) => s.golden_trajectory?.length);
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
    try {
      const rows = [];
      for (const task of tasks) rows.push({ task: task.id, ...(await evaluateTask(store, agent, label, task)) });
      const endpointPass = rows.filter((r) => r.endpoint_ok).length;
      const pathOnly = rows.filter((r) => r.path_regressed).length;
      const trajFlagged = rows.filter((r) => !r.endpoint_ok || r.path_regressed).length;
      const trajectoryVerdict = trajFlagged > 0 ? "BLOCKED" : "PASS";
      const dbRows: Omit<EvalResultRow, "eval_run_id">[] = rows.map((r) => ({
        task_id: r.task,
        endpoint_ok: r.endpoint_ok,
        path_exact: r.path_exact,
        edit_dist: r.edit_dist,
        extra_calls: r.extra_calls,
        wrong_recover: r.wrong_recover,
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
        pathOnlyRegressions: pathOnly,
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
    tasksWithoutGolden: all.filter((s) => !s.golden_trajectory?.length).map((s) => s.id),
    changes,
    missedByEndpoint: candidates.filter((c) => c.endpointVerdict === "PASS" && c.trajectoryVerdict === "BLOCKED").length,
    pathOnlyRows: candidates.reduce((s, c) => s + (c.pathOnlyRegressions ?? 0), 0),
  };
}

async function evaluateTask(store: Store, agent: AgentFactory, label: string, task: Scenario) {
  const runId = await createRun(store, { scenario: task.id, mode: "durable", configLabel: label }, { agent });
  const out = await (await buildRuntime(store, runId, { agent })).drive();
  if (out.status === "failed" && /no recorded response|has not been recorded|changed since/.test(out.error)) {
    throw new Error(`${task.id}: ${out.error}`);
  }
  const state = fold(await store.listEvents(runId));
  const calls = trajectoryOf(state).map((c) => ({ tool: c.tool, args: c.args }));
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
  const tasks = all.filter((s) => s.golden_trajectory?.length);
  const latest = new Map<string, Awaited<ReturnType<Store["listEvalRuns"]>>[number]>();
  for (const r of await store.listEvalRuns(1000)) if (!latest.has(r.change_label)) latest.set(r.change_label, r);
  const results = await store.listEvalResults([...latest.values()].map((r) => r.id));

  const changes: ChangeResult[] = CONFIGS.map((cfg) => {
    const run = latest.get(cfg.label);
    if (!run) {
      const missing = tasks.filter((t) => !hasRecording(cfg.label, t.id)).map((t) => t.id);
      return { label: cfg.label, description: cfg.description, status: "not_recorded", missing };
    }
    const rows = results
      .filter((r) => r.eval_run_id === run.id)
      .map((r) => {
        const path_regressed = r.endpoint_ok && (r.edit_dist > 0 || r.extra_calls > 0 || r.wrong_recover);
        return { task: r.task_id, ...r, path_regressed };
      });
    return {
      label: cfg.label,
      description: cfg.description,
      status: "evaluated",
      evalRunId: run.id,
      endpointPass: run.endpoint_pass,
      total: run.endpoint_total,
      trajFlagged: run.traj_flagged,
      pathOnlyRegressions: rows.filter((r) => r.path_regressed).length,
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
    tasksWithoutGolden: all.filter((s) => !s.golden_trajectory?.length).map((s) => s.id),
    changes,
    missedByEndpoint: candidates.filter((c) => c.endpointVerdict === "PASS" && c.trajectoryVerdict === "BLOCKED").length,
    pathOnlyRows: candidates.reduce((s, c) => s + (c.pathOnlyRegressions ?? 0), 0),
    evaluatedAt,
  };
}
