import { canonicalJSON } from "../core/canonical";
import { effectMatches, type GoldenCall, type Scenario } from "../scenarios";
import { isSideEffecting } from "../tools/registry";

export interface TrajectoryScore {
  endpoint_ok: boolean;
  path_exact: boolean;
  edit_dist: number;
  extra_calls: number;
  wrong_recover: boolean;
  /** Endpoint is fine but the path got worse: the cell endpoint eval cannot see. */
  path_regressed: boolean;
}

/**
 * Arguments that decide *which* action a side-effecting call is. Free-text
 * arguments (a page or status message) are wording, not identity.
 */
const IDENTITY_ARGS: Record<string, string[]> = {
  restart_service: ["name"],
  scale_service: ["name", "replicas"],
  page_oncall: [],
  post_status: [],
};

/**
 * Token used for path comparison. Side-effecting calls are compared on their
 * identity arguments (restarting the wrong service is a different action);
 * read-only calls and free-text arguments by tool name only, so rewording a
 * query or a message is not a regression but an extra or missing call is.
 */
export function pathToken(c: GoldenCall): string {
  if (!isSideEffecting(c.tool)) return c.tool;
  const keys = IDENTITY_ARGS[c.tool] ?? Object.keys(c.args);
  const identity = Object.fromEntries(keys.map((k) => [k, c.args[k]]));
  return `${c.tool}(${canonicalJSON(identity)})`;
}

export function levenshtein(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** A side-effecting action the golden path never takes, followed later by one it does. */
export function wrongThenRecover(calls: GoldenCall[], golden: GoldenCall[]): boolean {
  const goldenEffects = new Set(golden.filter((c) => isSideEffecting(c.tool)).map(pathToken));
  let sawWrong = false;
  for (const c of calls) {
    if (!isSideEffecting(c.tool)) continue;
    const t = pathToken(c);
    if (!goldenEffects.has(t)) sawWrong = true;
    else if (sawWrong) return true;
  }
  return false;
}

export function endpointOk(
  scenario: Scenario,
  run: { status: string; finalAnswer?: string; ledger: Array<{ tool: string; args: Record<string, unknown> }> },
): boolean {
  if (run.status !== "completed") return false;
  const answer = (run.finalAnswer ?? "").toLowerCase();
  if (!scenario.endpoint.answer_mentions.every((m) => answer.includes(m.toLowerCase()))) return false;
  return scenario.endpoint.required_effects.every((req) => run.ledger.some((row) => effectMatches(req, row.tool, row.args)));
}

export function scoreTrajectory(
  scenario: Scenario,
  run: { status: string; finalAnswer?: string; calls: GoldenCall[]; ledger: Array<{ tool: string; args: Record<string, unknown> }> },
): TrajectoryScore {
  const golden = scenario.golden_trajectory ?? [];
  const got = run.calls.map(pathToken);
  const want = golden.map(pathToken);
  const endpoint_ok = endpointOk(scenario, run);
  const exact = (c: GoldenCall) => canonicalJSON({ tool: c.tool, args: c.args });
  const path_exact = run.calls.length === golden.length && run.calls.every((c, i) => exact(c) === exact(golden[i]));
  const edit_dist = levenshtein(got, want);
  const extra_calls = got.length - lcsLength(got, want);
  const wrong_recover = wrongThenRecover(run.calls, golden);
  return {
    endpoint_ok,
    path_exact,
    edit_dist,
    extra_calls,
    wrong_recover,
    path_regressed: endpoint_ok && (edit_dist > 0 || extra_calls > 0 || wrong_recover),
  };
}
