import { canonicalJSON } from "../core/canonical";
import { fold, trajectoryOf } from "../core/events";
import { CRASH_WINDOWS, type CrashPlan, type CrashWindow } from "../runtime/crash";
import { buildRuntime, createRun, defaultAgentFactory, prepareResume, type AgentFactory } from "../runtime/runs";
import { loadScenario } from "../scenarios";
import { actionIdentity, isSideEffecting } from "../tools/registry";
import type { Store } from "../store/store";
import { MALFORMED_KINDS, MalformedInjectingLLM, type MalformedKind } from "./malformed";

export interface CrashExperimentOptions {
  scenario?: string;
  n: number;
  seed?: number;
  agent?: AgentFactory;
}

interface WindowStats {
  trials: number;
  durableCorrect: number;
  durableDuplicateRows: number;
  naiveMeasured: number;
  /** Trials whose crash landed after a side effect had already happened: the only ones that can duplicate. */
  naiveExposed: number;
  naiveTrialsWithDuplicates: number;
  naiveDuplicateRows: number;
  naiveUnrecorded: number;
}

export interface MalformedCase {
  kind: MalformedKind;
  variant: "exhaust_retries" | "self_correct";
  status: "completed" | "failed" | "unrecorded";
  rejected: number;
  invokedAfterRejection: number;
  sideEffectRowsFromRejectedSteps: number;
  ledgerDelta: number;
  detail?: string;
}

export interface CrashSummary {
  scenario: string;
  n: number;
  seed: number;
  reference: { runId: string; steps: number; toolCalls: number; sideEffects: number };
  durable: { trials: number; correct: number; correctPct: number; duplicateSideEffects: number };
  naive: {
    trials: number;
    measured: number;
    unrecorded: number;
    exposed: number;
    trialsWithDuplicates: number;
    duplicateRatePct: number | null;
    /** Share of the trials that could duplicate at all, which is the honest denominator. */
    duplicateRateWhenExposedPct: number | null;
    duplicateRows: number;
  };
  byWindow: Record<CrashWindow, WindowStats>;
  malformed: { cases: MalformedCase[]; allBlocked: boolean };
  durationMs: number;
}

export class ExperimentError extends Error {}

/** Small seeded PRNG so a run of the experiment can be reproduced from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const signature = (rows: Array<{ step: number; tool: string; args: unknown }>) =>
  rows.map((r) => `${r.step}|${r.tool}|${canonicalJSON(r.args)}`).join("\n");

/**
 * A repeated side effect is the same *action* twice, not the same bytes twice:
 * a restarted agent that pages on-call again writes a differently worded
 * message, and the human is still paged twice.
 */
function duplicateRows(rows: Array<{ tool: string; args: Record<string, unknown> }>): number {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = actionIdentity(r.tool, r.args);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].reduce((sum, c) => sum + (c - 1), 0);
}

const isRecordingGap = (err: string | undefined) => !!err && /no recorded response|has not been recorded/.test(err);

export async function runCrashExperiment(store: Store, opts: CrashExperimentOptions): Promise<CrashSummary> {
  const started = Date.now();
  const scenarioId = opts.scenario ?? "incident_checkout_cascade";
  loadScenario(scenarioId);
  const agent = opts.agent ?? defaultAgentFactory();
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);

  // Reference: the same scenario, same recording, no crash.
  const refId = await createRun(store, { scenario: scenarioId, mode: "durable" }, { agent });
  const refOutcome = await (await buildRuntime(store, refId, { agent })).drive();
  if (refOutcome.status !== "completed") {
    throw new ExperimentError(`reference run did not complete: ${"error" in refOutcome ? refOutcome.error : refOutcome.status}`);
  }
  const refState = fold(await store.listEvents(refId));
  const refLedger = await store.listSideEffects(refId);
  const refSig = signature(refLedger);
  const refTrajectory = trajectoryOf(refState);
  const toolCalls = refTrajectory.length;

  const byWindow = Object.fromEntries(
    CRASH_WINDOWS.map((w) => [
      w,
      { trials: 0, durableCorrect: 0, durableDuplicateRows: 0, naiveMeasured: 0, naiveExposed: 0, naiveTrialsWithDuplicates: 0, naiveDuplicateRows: 0, naiveUnrecorded: 0 },
    ]),
  ) as Record<CrashWindow, WindowStats>;

  for (let i = 0; i < opts.n; i++) {
    const window = CRASH_WINDOWS[i % CRASH_WINDOWS.length];
    const plan: CrashPlan = { window, target: { kind: "tool_call", index: Math.floor(rng() * toolCalls) } };
    const stats = byWindow[window];
    stats.trials++;

    // --- durable: crash, discard the runtime, resume from the log ---------
    const dId = await createRun(store, { scenario: scenarioId, mode: "durable" }, { agent });
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = await buildRuntime(store, dId, { agent, crash: plan });
    const first = await runtime.drive();
    runtime = null;
    if (first.status !== "crashed") throw new ExperimentError(`durable trial ${i} did not reach its crash point`);
    await prepareResume(store, dId);
    const resumed = await (await buildRuntime(store, dId, { agent })).drive();
    const dLedger = await store.listSideEffects(dId);
    const correct =
      resumed.status === "completed" && resumed.finalAnswer === refOutcome.finalAnswer && signature(dLedger) === refSig;
    if (correct) stats.durableCorrect++;
    stats.durableDuplicateRows += Math.max(0, dLedger.length - refLedger.length);

    // --- naive baseline: same crash point, restart from scratch ------------
    const nId = await createRun(store, { scenario: scenarioId, mode: "naive" }, { agent });
    let naiveRt: Awaited<ReturnType<typeof buildRuntime>> | null = await buildRuntime(store, nId, { agent, crash: plan });
    await naiveRt.drive();
    naiveRt = null;
    await prepareResume(store, nId);
    const nOut = await (await buildRuntime(store, nId, { agent })).drive();
    if (nOut.status === "failed" && isRecordingGap(nOut.error)) {
      // After a restart the naive agent observes a world its own earlier
      // attempt already changed; if that conversation was never recorded,
      // we report the gap instead of guessing what the model would do.
      stats.naiveUnrecorded++;
      continue;
    }
    const dup = duplicateRows(await store.listNaiveSideEffects(nId));
    stats.naiveMeasured++;
    // Could this trial have duplicated at all? Only if a side effect had
    // already been performed when the crash hit.
    const index = plan.target.kind === "tool_call" ? plan.target.index : 0;
    const performedBefore =
      refTrajectory.slice(0, index).filter((c) => isSideEffecting(c.tool)).length +
      (isSideEffecting(refTrajectory[index]?.tool ?? "") && (window === "W3" || window === "W4") ? 1 : 0);
    if (performedBefore > 0) {
      stats.naiveExposed++;
      if (dup > 0) stats.naiveTrialsWithDuplicates++;
    }
    stats.naiveDuplicateRows += dup;
  }

  const sum = (k: keyof WindowStats) => CRASH_WINDOWS.reduce((s, w) => s + byWindow[w][k], 0);
  const naiveMeasured = sum("naiveMeasured");
  const malformed = await runMalformedBatch(store, scenarioId, agent, refState);

  return {
    scenario: scenarioId,
    n: opts.n,
    seed,
    reference: { runId: refId, steps: refState.steps.length, toolCalls, sideEffects: refLedger.length },
    durable: {
      trials: opts.n,
      correct: sum("durableCorrect"),
      correctPct: opts.n ? (100 * sum("durableCorrect")) / opts.n : 0,
      duplicateSideEffects: sum("durableDuplicateRows"),
    },
    naive: {
      trials: opts.n,
      measured: naiveMeasured,
      unrecorded: sum("naiveUnrecorded"),
      exposed: sum("naiveExposed"),
      trialsWithDuplicates: sum("naiveTrialsWithDuplicates"),
      duplicateRatePct: naiveMeasured ? (100 * sum("naiveTrialsWithDuplicates")) / naiveMeasured : null,
      duplicateRateWhenExposedPct: sum("naiveExposed") ? (100 * sum("naiveTrialsWithDuplicates")) / sum("naiveExposed") : null,
      duplicateRows: sum("naiveDuplicateRows"),
    },
    byWindow,
    malformed,
    durationMs: Date.now() - started,
  };
}

/**
 * Injects each malformed output twice: once until retries are exhausted
 * (must fail cleanly with zero side effects) and once just before the first
 * side-effecting call (must be rejected, then the run continues).
 */
async function runMalformedBatch(
  store: Store,
  scenarioId: string,
  agent: AgentFactory,
  refState: ReturnType<typeof fold>,
): Promise<{ cases: MalformedCase[]; allBlocked: boolean }> {
  const firstEffectTurn = refState.steps.findIndex(
    (s) => s?.invoked && ["restart_service", "scale_service", "page_oncall", "post_status"].includes(s.invoked.tool_name),
  );
  const cases: MalformedCase[] = [];
  for (const kind of MALFORMED_KINDS) {
    for (const variant of ["exhaust_retries", "self_correct"] as const) {
      const injected: AgentFactory = (label, task) => {
        const base = agent(label, task);
        const times = variant === "exhaust_retries" ? base.config.maxInvalidRetries + 1 : 1;
        const at = variant === "exhaust_retries" ? 0 : Math.max(0, firstEffectTurn);
        return { config: base.config, llm: new MalformedInjectingLLM(base.llm, kind, at, times) };
      };
      const before = await store.countAllSideEffects();
      const runId = await createRun(store, { scenario: scenarioId, mode: "durable" }, { agent: injected });
      const out = await (await buildRuntime(store, runId, { agent: injected })).drive();
      const events = await store.listEvents(runId);
      const ledger = await store.listSideEffects(runId);
      const rejectedSteps = new Set(events.filter((e) => e.kind === "TOOL_REJECTED").map((e) => e.step));
      const status = out.status === "failed" && isRecordingGap(out.error) ? "unrecorded" : out.status === "completed" ? "completed" : "failed";
      cases.push({
        kind,
        variant,
        status,
        rejected: rejectedSteps.size,
        invokedAfterRejection: events.filter((e) => e.kind === "TOOL_INVOKED" && rejectedSteps.has(e.step)).length,
        sideEffectRowsFromRejectedSteps: ledger.filter((r) => rejectedSteps.has(r.step)).length,
        ledgerDelta: (await store.countAllSideEffects()) - before,
        detail: out.status === "failed" ? out.error : undefined,
      });
    }
  }
  const allBlocked = cases.every(
    (c) =>
      c.rejected > 0 &&
      c.invokedAfterRejection === 0 &&
      c.sideEffectRowsFromRejectedSteps === 0 &&
      (c.variant === "self_correct" || (c.status === "failed" && c.ledgerDelta === 0)),
  );
  return { cases, allBlocked };
}
