import { canonicalJSON } from "../core/canonical";
import { fold, type RunMode } from "../core/events";
import type { Scenario } from "../scenarios";
import type { Store } from "../store/store";
import { argsHash, currentWorld, isSideEffecting, runTool, ToolError } from "../tools/registry";

export interface ToolCall {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  idemKey: string;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface ToolExecutor {
  invoke(call: ToolCall): Promise<ToolOutcome>;
}

/**
 * Mock tools whose entire world state lives in the database: static scenario
 * config plus the side-effect ledger of this run. Nothing is cached in memory,
 * so a crash loses nothing that a resume would need.
 */
export class DbToolExecutor implements ToolExecutor {
  constructor(
    private store: Store,
    private runId: string,
    private mode: RunMode,
    private scenario: Scenario,
  ) {}

  async invoke(call: ToolCall): Promise<ToolOutcome> {
    const ledger =
      this.mode === "durable" ? await this.store.listSideEffects(this.runId) : await this.store.listNaiveSideEffects(this.runId);
    let result: unknown;
    try {
      result = runTool(call.tool, call.args, currentWorld(this.scenario, ledger));
    } catch (e) {
      if (e instanceof ToolError) return { ok: false, error: e.message };
      throw e;
    }
    if (!isSideEffecting(call.tool)) {
      // A real monitoring API lets you tell "nothing changed" from "I have not
      // looked yet". Without that, an agent can mistake re-reading for waiting
      // and poll the same metric until it runs out of steps.
      const previous = await this.previousIdenticalRead(call);
      if (previous !== undefined && canonicalJSON(previous.result) === canonicalJSON(result)) {
        return { ok: true, result: { ...(result as object), note: `unchanged since the identical call at step ${previous.step}` } };
      }
      return { ok: true, result };
    }

    if (this.mode === "durable") {
      // ON CONFLICT on idem_key: if a previous attempt already performed this
      // effect, we get its stored result back and perform nothing.
      const rec = await this.store.recordSideEffect({ ...call, runId: this.runId, result });
      return { ok: true, result: rec.result };
    }
    await this.store.insertNaiveSideEffect({
      runId: this.runId,
      step: call.step,
      tool: call.tool,
      args: call.args,
      argsHash: argsHash({ tool: call.tool, args: call.args }),
    });
    return { ok: true, result };
  }

  private async previousIdenticalRead(call: ToolCall): Promise<{ step: number; result: unknown } | undefined> {
    const state = fold(await this.store.listEvents(this.runId));
    for (const st of state.steps) {
      if (!st?.invoked || st.step >= call.step) continue;
      if (st.invoked.tool_name !== call.tool || canonicalJSON(st.invoked.args) !== canonicalJSON(call.args)) continue;
      if (st.outcome?.kind === "committed") return { step: st.step, result: st.outcome.result };
    }
    return undefined;
  }
}
