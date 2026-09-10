/**
 * Application-level crash injection.
 *
 *   W1  after the LLM chose a tool, before TOOL_INVOKED is logged
 *   W2  TOOL_INVOKED logged, before the tool runs
 *   W3  the tool (and its side effect) ran, before TOOL_COMMITTED is logged   <- the dangerous one
 *   W4  TOOL_COMMITTED logged, before the next LLM call
 *
 * Why an exception instead of process.exit(): the web server, the demo UI and
 * the experiment harness all live in this one Node process, so killing it
 * would kill the observer too. Throwing CrashInjected aborts the run at the
 * exact point a kill would, and the caller then throws the whole Runtime
 * instance away and builds a new one from the database — so the resume path
 * gets no more information than it would after a real crash.
 *
 * What this does NOT model (and a real kill would): torn writes inside a
 * single DB statement, un-fsynced commits lost on power failure, and a crash
 * in the middle of the tool's own work. The first two are the database's
 * durability guarantee; the third is covered because a side effect here is a
 * single atomic ledger insert.
 */
export type CrashWindow = "W1" | "W2" | "W3" | "W4";
export const CRASH_WINDOWS: CrashWindow[] = ["W1", "W2", "W3", "W4"];

export type CrashTarget =
  /** The n-th dispatched tool call of the attempt (0-based). */
  | { kind: "tool_call"; index: number }
  | { kind: "next_tool_call" }
  | { kind: "next_side_effect" }
  /** The next call to a specific tool. */
  | { kind: "tool"; tool: string };

export interface CrashPlan {
  window: CrashWindow;
  target: CrashTarget;
}

export interface CrashPoint {
  window: CrashWindow;
  step: number;
  tool: string;
  sideEffect: boolean;
  dispatchIndex: number;
}

export class CrashInjected extends Error {
  constructor(readonly point: CrashPoint) {
    super(`crash injected at ${point.window} (step ${point.step}, ${point.tool})`);
  }
}

/** Owned by exactly one Runtime instance; there is no global crash state. */
export class CrashInjector {
  private plan: CrashPlan | undefined;

  constructor(plan?: CrashPlan) {
    this.plan = plan;
  }

  arm(plan: CrashPlan): void {
    this.plan = plan;
  }

  get armed(): CrashPlan | undefined {
    return this.plan;
  }

  check(point: CrashPoint): void {
    const p = this.plan;
    if (!p || p.window !== point.window) return;
    const hit =
      p.target.kind === "next_tool_call" ||
      (p.target.kind === "next_side_effect" && point.sideEffect) ||
      (p.target.kind === "tool_call" && p.target.index === point.dispatchIndex) ||
      (p.target.kind === "tool" && p.target.tool === point.tool);
    if (!hit) return;
    this.plan = undefined;
    throw new CrashInjected(point);
  }
}
