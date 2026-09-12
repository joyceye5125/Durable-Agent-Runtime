import { idempotencyKey } from "../core/canonical";
import { apply, fold, invalidStreak, nextAction, type NewEvent, type RunEvent, type RunState } from "../core/events";
import type { ResolvedConfig } from "../llm/configs";
import { buildMessages, type LLM } from "../llm/types";
import type { Scenario } from "../scenarios";
import type { RunStatus } from "../store/store";
import { isSideEffecting, validateCall } from "../tools/registry";
import { CrashInjected, CrashInjector, type CrashPlan, type CrashPoint, type CrashWindow } from "./crash";
import type { ToolExecutor } from "./executor";

/** Where a runtime reads and appends its events. The database in production; memory for faithful replay. */
/**
 * A budget the config sets on purpose wins, so the step-budget candidate keeps
 * its cut everywhere; otherwise a long scenario may raise the default, since
 * running out of steps is not what that scenario is testing.
 */
export function stepBudget(config: Pick<ResolvedConfig, "maxSteps" | "maxStepsOverride">, scenario: Pick<Scenario, "max_steps">): number {
  return config.maxStepsOverride ?? scenario.max_steps ?? config.maxSteps;
}

export interface RunSink {
  load(): Promise<Array<RunEvent | NewEvent>>;
  append(e: NewEvent): Promise<void>;
  setStatus(status: RunStatus): Promise<void>;
}

export interface RuntimeDeps {
  runId: string;
  sink: RunSink;
  llm: LLM;
  tools: ToolExecutor;
  config: ResolvedConfig;
  scenario: Scenario;
  /** Delay before each LLM call, so the UI can show a run unfolding. 0 in experiments. */
  paceMs?: number;
  crash?: CrashPlan;
}

export type RunOutcome =
  | { status: "completed"; finalAnswer: string }
  | { status: "failed"; error: string }
  | { status: "crashed"; point: CrashPoint };

/**
 * Drives one run of the agent loop. It owns no authoritative state: `state`
 * is only a cache of fold(events), rebuilt from the log at the start of every
 * drive(). Starting a run, resuming it after a crash and replaying it are
 * therefore the same code path.
 */
export class Runtime {
  private state: RunState | null = null;
  private dead = false;
  private readonly crash: CrashInjector;

  constructor(private deps: RuntimeDeps) {
    this.crash = new CrashInjector(deps.crash);
  }

  /** Arms a crash for a run that is already executing (the UI's Crash button). */
  armCrash(plan: CrashPlan): void {
    this.crash.arm(plan);
  }

  async drive(): Promise<RunOutcome> {
    if (this.dead) {
      throw new Error("this Runtime crashed; build a new one from the database to resume");
    }
    try {
      return await this.loop();
    } catch (e) {
      if (!(e instanceof CrashInjected)) throw e;
      // Everything this instance holds is now considered lost, exactly as a
      // killed process would lose it. It refuses further use, and callers must
      // drop their reference and resume with a fresh Runtime built only from
      // the event log (see buildRuntime). If resume were allowed to reuse this
      // object, a "successful recovery" could silently depend on memory that
      // would not exist after a real crash.
      this.dead = true;
      this.state = null;
      // A real crashed process could not write this; it stands in for the
      // supervisor noticing the crash. Resume never reads runs.status.
      await this.deps.sink.setStatus("crashed");
      return { status: "crashed", point: e.point };
    }
  }

  private async loop(): Promise<RunOutcome> {
    const { sink, config } = this.deps;
    this.state = fold(await sink.load());
    if (this.state.configHash !== config.hash) {
      throw new Error(`run was started with config ${this.state.configHash.slice(0, 12)}, refusing to continue with ${config.hash.slice(0, 12)}`);
    }
    for (;;) {
      const next = nextAction(this.state);
      switch (next.kind) {
        case "done":
          return this.finish();
        case "call_llm":
          await this.callLlm(next.step);
          break;
        case "complete":
          await this.emit({ step: next.step, kind: "RUN_COMPLETED", data: { final_answer: this.stepAt(next.step).llm!.response } });
          break;
        case "dispatch":
          await this.dispatch(next.step);
          break;
        case "reinvoke":
          await this.execute(next.step);
          break;
      }
    }
  }

  private async finish(): Promise<RunOutcome> {
    const s = this.state!;
    await this.deps.sink.setStatus(s.status === "completed" ? "completed" : "failed");
    return s.status === "completed" ? { status: "completed", finalAnswer: s.finalAnswer ?? "" } : { status: "failed", error: s.error ?? "" };
  }

  private async callLlm(step: number): Promise<void> {
    const { config, scenario, llm, paceMs } = this.deps;
    const maxSteps = stepBudget(config, scenario);
    if (step >= maxSteps) {
      await this.emit({ step, kind: "RUN_FAILED", data: { error: `max_steps (${maxSteps}) reached without a final answer` } });
      return;
    }
    if (paceMs) await sleep(paceMs);
    let res;
    try {
      res = await llm.complete({ system: config.systemPrompt, messages: buildMessages(scenario.task, this.state!.steps), tools: config.tools });
    } catch (e) {
      await this.emit({ step, kind: "RUN_FAILED", data: { error: `llm: ${(e as Error).message}` } });
      return;
    }
    await this.emit({
      step,
      kind: "LLM_RESPONDED",
      data: {
        step,
        response: res.text,
        tool_name: res.toolCall?.name,
        tool_args: res.toolCall?.argsRaw,
        is_final: !res.toolCall,
        tokens_in: res.tokensIn,
        tokens_out: res.tokensOut,
      },
    });
  }

  private async dispatch(step: number): Promise<void> {
    const { config, runId } = this.deps;
    const llm = this.stepAt(step).llm!;
    const call = validateCall(llm.tool_name, llm.tool_args);
    if (!call.ok) {
      // Rejected before TOOL_INVOKED: a hallucinated or malformed call can
      // never reach a tool, so it can never cause a side effect.
      await this.emit({ step, kind: "TOOL_REJECTED", data: { step, reason: call.reason } });
      if (invalidStreak(this.state!) > config.maxInvalidRetries) {
        await this.emit({ step, kind: "RUN_FAILED", data: { error: `gave up after ${config.maxInvalidRetries} invalid tool-call retries` } });
      }
      return;
    }
    const idemKey = idempotencyKey(runId, step, call.tool, call.args);
    this.checkpoint("W1", step, call.tool);
    await this.emit({ step, kind: "TOOL_INVOKED", data: { step, tool_name: call.tool, args: call.args, idem_key: idemKey } });
    this.checkpoint("W2", step, call.tool);
    await this.execute(step);
  }

  private async execute(step: number): Promise<void> {
    const inv = this.stepAt(step).invoked!;
    const out = await this.deps.tools.invoke({ step, tool: inv.tool_name, args: inv.args, idemKey: inv.idem_key });
    this.checkpoint("W3", step, inv.tool_name);
    await this.emit(
      out.ok
        ? { step, kind: "TOOL_COMMITTED", data: { step, result: out.result } }
        : { step, kind: "TOOL_FAILED", data: { step, error: out.error } },
    );
    this.checkpoint("W4", step, inv.tool_name);
  }

  private checkpoint(window: CrashWindow, step: number, tool: string): void {
    const dispatchIndex = this.state!.steps.filter((s) => s?.invoked && s.step < step).length;
    this.crash.check({ window, step, tool, sideEffect: isSideEffecting(tool), dispatchIndex });
  }

  /** Log first, then update the cache: memory is never ahead of the log. */
  private async emit(e: NewEvent): Promise<void> {
    await this.deps.sink.append(e);
    this.state = apply(this.state!, e);
  }

  private stepAt(step: number) {
    return this.state!.steps[step]!;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
