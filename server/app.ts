import express, { type NextFunction, type Request, type Response } from "express";
import { fold, nextAction, trajectoryOf } from "./core/events";
import { ExperimentError, runCrashExperiment } from "./experiments/crash";
import { CONFIGS } from "./llm/configs";
import { hasRecording, llmMode, NotRecordedError, RecordingMissError, RecordingStaleError } from "./llm/recording";
import { faithfulReplay } from "./replay";
import { CRASH_WINDOWS, type CrashPlan, type CrashTarget, type CrashWindow } from "./runtime/crash";
import { buildRuntime, createRun, prepareResume, type AgentFactory } from "./runtime/runs";
import type { Runtime } from "./runtime/runtime";
import { listScenarioIds, loadScenario } from "./scenarios";
import type { Store } from "./store/store";

export interface AppOptions {
  store: Store;
  /** Injected in tests; defaults to recordings (or the live model when LLM_MODE=live). */
  agent?: AgentFactory;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_PACE_MS = 350;

export function createApp({ store, agent }: AppOptions) {
  const app = express();
  app.use(express.json());

  // Handles to runs that are executing right now, so the Crash button can
  // reach them. This is not run state: an entry is removed the moment its
  // Runtime finishes or crashes, and resume always builds a new Runtime.
  const executing = new Map<string, Runtime>();
  let experimentRunning = false;

  function launch(runId: string, runtime: Runtime) {
    executing.set(runId, runtime);
    runtime
      .drive()
      .catch((e) => console.error(`[run ${runId}]`, e))
      .finally(() => executing.delete(runId));
  }

  app.get("/api/meta", (_req, res) => {
    const scenarios = listScenarioIds().map((id) => {
      const s = loadScenario(id);
      return {
        id,
        kind: s.kind,
        task: s.task,
        hasGolden: !!s.golden_trajectory?.length,
        recorded: CONFIGS.filter((c) => hasRecording(c.label, id)).map((c) => c.label),
      };
    });
    res.json({
      llmMode: llmMode(),
      db: store.driver.kind,
      windows: CRASH_WINDOWS,
      scenarios,
      configs: CONFIGS.map((c) => ({ label: c.label, description: c.description })),
    });
  });

  app.post("/api/runs", async (req, res) => {
    const { scenario, mode, config, crash, paceMs } = req.body ?? {};
    if (typeof scenario !== "string") throw new HttpError(400, "scenario is required");
    if (mode !== "durable" && mode !== "naive") throw new HttpError(400, "mode must be durable or naive");
    const plan = crash ? parseCrash(crash) : undefined;
    const runId = await createRun(store, { scenario, mode, configLabel: config }, { agent });
    launch(runId, await buildRuntime(store, runId, { agent, crash: plan, paceMs: pace(paceMs) }));
    res.status(201).json({ runId });
  });

  app.post("/api/runs/:id/crash", (req, res) => {
    const runtime = executing.get(req.params.id);
    if (!runtime) throw new HttpError(409, "run is not executing; arm a crash while it runs or pass `crash` when starting it");
    const plan = parseCrash(req.body ?? {});
    runtime.armCrash(plan);
    res.json({ armed: plan });
  });

  app.post("/api/runs/:id/resume", async (req, res) => {
    const runId = req.params.id;
    if (executing.has(runId)) throw new HttpError(409, "run is still executing");
    await prepareResume(store, runId).catch((e: Error) => {
      throw new HttpError(409, e.message);
    });
    // A new Runtime whose only inputs are the database and static files.
    launch(runId, await buildRuntime(store, runId, { agent, paceMs: pace(req.body?.paceMs) }));
    res.json({ runId, resumed: true });
  });

  app.get("/api/runs/:id", async (req, res) => {
    const run = await store.getRun(req.params.id);
    if (!run) throw new HttpError(404, "no such run");
    const events = await store.listEvents(run.id);
    const state = fold(events);
    const ledger = run.mode === "durable" ? await store.listSideEffects(run.id) : await store.listNaiveSideEffects(run.id);
    res.json({
      run,
      executing: executing.has(run.id),
      state: {
        status: state.status,
        attempts: state.attempts,
        finalAnswer: state.finalAnswer,
        error: state.error,
        tokens: state.tokensIn + state.tokensOut,
        next: nextAction(state),
      },
      trajectory: trajectoryOf(state),
      events,
      ledger,
    });
  });

  app.get("/api/runs/:id/replay", async (req, res) => {
    if (req.query.faithful !== "true") throw new HttpError(400, "only faithful=true is supported here; divergence replay is the eval experiment");
    const run = await store.getRun(req.params.id);
    if (!run) throw new HttpError(404, "no such run");
    res.json(await faithfulReplay(await store.listEvents(run.id), loadScenario(run.scenario)));
  });

  app.post("/api/experiments/crash", async (req, res) => {
    const n = Math.min(Math.max(Number(req.body?.n ?? 100), 4), 500);
    const scenario = typeof req.body?.scenario === "string" ? req.body.scenario : undefined;
    const summary = await exclusive(() => runCrashExperiment(store, { scenario, n, agent }));
    const id = await store.insertCrashExperiment(summary.scenario, summary.n, summary);
    res.json({ id, summary });
  });

  app.get("/api/experiments/results", async (_req, res) => {
    res.json({ crash: await store.listCrashExperiments(20) });
  });

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (experimentRunning) throw new HttpError(409, "an experiment is already running");
    experimentRunning = true;
    try {
      return await fn();
    } finally {
      experimentRunning = false;
    }
  }

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "no such endpoint")));
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status =
      err instanceof HttpError
        ? err.status
        : err instanceof NotRecordedError || err instanceof RecordingStaleError || err instanceof RecordingMissError
          ? 409
          : err instanceof ExperimentError
            ? 409
            : /unknown (scenario|config)/.test(err.message)
              ? 400
              : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return app;
}

function pace(v: unknown): number {
  const n = Number(v ?? DEFAULT_PACE_MS);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 2000) : DEFAULT_PACE_MS;
}

function parseCrash(body: { window?: unknown; target?: unknown }): CrashPlan {
  if (!CRASH_WINDOWS.includes(body.window as CrashWindow)) throw new HttpError(400, "window must be one of W1..W4");
  const t = (body.target ?? { kind: "next_tool_call" }) as CrashTarget;
  if (!["tool_call", "next_tool_call", "next_side_effect"].includes(t.kind)) throw new HttpError(400, "bad crash target");
  return { window: body.window as CrashWindow, target: t };
}
