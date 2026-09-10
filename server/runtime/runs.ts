import { randomUUID } from "node:crypto";
import { fold, type NewEvent, type RunMode } from "../core/events";
import { openAgentLLM, type LlmMode } from "../llm/recording";
import type { LLM } from "../llm/types";
import type { ResolvedConfig } from "../llm/configs";
import { loadScenario } from "../scenarios";
import type { Store } from "../store/store";
import type { CrashPlan } from "./crash";
import { DbToolExecutor } from "./executor";
import { Runtime, type RunSink } from "./runtime";

export interface AgentFactory {
  (configLabel: string, taskId: string): { config: ResolvedConfig; llm: LLM };
}

export function defaultAgentFactory(mode?: LlmMode): AgentFactory {
  return (label, task) => openAgentLLM(label, task, mode);
}

export interface RunOptions {
  agent?: AgentFactory;
  paceMs?: number;
  crash?: CrashPlan;
}

export function dbSink(store: Store, runId: string): RunSink {
  return {
    load: () => store.listEvents(runId),
    append: async (e: NewEvent) => {
      await store.appendEvent(runId, e);
    },
    setStatus: (s) => store.setRunStatus(runId, s),
  };
}

export async function createRun(
  store: Store,
  p: { scenario: string; mode: RunMode; configLabel?: string },
  opts: RunOptions = {},
): Promise<string> {
  const configLabel = p.configLabel ?? "baseline";
  const { config } = (opts.agent ?? defaultAgentFactory())(configLabel, p.scenario);
  loadScenario(p.scenario);
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await store.createRun({ id: runId, scenario: p.scenario, mode: p.mode, configLabel });
  await store.appendEvent(runId, {
    step: 0,
    kind: "RUN_STARTED",
    data: { scenario: p.scenario, config_label: configLabel, config_hash: config.hash, mode: p.mode },
  });
  return runId;
}

/**
 * Builds a brand-new Runtime whose only inputs are the database and the
 * static scenario/config files. Used both for the first drive and for every
 * resume; nothing from a previous Runtime instance can leak in.
 */
export async function buildRuntime(store: Store, runId: string, opts: RunOptions = {}): Promise<Runtime> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const scenario = loadScenario(run.scenario);
  const { config, llm } = (opts.agent ?? defaultAgentFactory())(run.config_label, run.scenario);
  return new Runtime({
    runId,
    sink: dbSink(store, runId),
    llm,
    tools: new DbToolExecutor(store, runId, run.mode, scenario),
    config,
    scenario,
    paceMs: opts.paceMs,
    crash: opts.crash,
  });
}

/**
 * Prepares a crashed (or otherwise interrupted) run for a new Runtime.
 * durable: nothing to do — the new Runtime folds the log and continues from
 *          the exact step where it stopped.
 * naive:   the baseline has no recovery; it starts the task over from
 *          scratch, re-executing every tool call, which is what exposes
 *          duplicate side effects.
 */
export async function prepareResume(store: Store, runId: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const events = await store.listEvents(runId);
  const state = fold(events);
  if (state.status !== "running") throw new Error(`run ${runId} already ${state.status}`);
  if (run.mode === "naive") {
    await store.appendEvent(runId, {
      step: 0,
      kind: "RUN_STARTED",
      data: { scenario: run.scenario, config_label: run.config_label, config_hash: state.configHash, mode: "naive", restart: true },
    });
  }
  await store.setRunStatus(runId, "running");
}
