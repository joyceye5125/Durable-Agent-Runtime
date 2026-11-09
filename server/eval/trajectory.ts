import { canonicalJSON } from "../core/canonical";
import { alertedMetrics, effectMatches, type GoldenCall, type Scenario } from "../scenarios";
import { actionIdentity, currentWorld, isSideEffecting } from "../tools/registry";

/**
 * A named requirement the run broke. Each one is a rule stated in advance, not
 * a distance from the reference path: a run can take a different route and
 * break none of them, and a run can follow the reference closely and break one.
 */
export type ProcessRule =
  | "repeated_action"
  | "rejected_call"
  | "unverified_remediation"
  | "unflagged_production_change"
  | "claims_recovery_while_alert_open";

export const PROCESS_RULES: Record<ProcessRule, string> = {
  repeated_action: "performed the same action twice",
  rejected_call: "called a tool with a target that does not exist",
  unverified_remediation: "changed production and never read anything afterwards",
  unflagged_production_change: "changed a service that nothing in the environment had flagged",
  claims_recovery_while_alert_open: "reported recovery while the alerting signal was still at its alerting value",
};

export interface TrajectoryScore {
  /** The task was completed: answer names what it must, required effects happened. */
  endpoint_ok: boolean;
  // --- comparison with the reference path: descriptive, never a verdict ---
  path_exact: boolean;
  edit_dist: number;
  extra_calls: number;
  wrong_recover: boolean;
  /** The path differs from the reference. Different is not worse. */
  diverged: boolean;
  // --- stated requirements ---
  violations: ProcessRule[];
  /**
   * BLOCKED: the task failed, or a stated requirement was broken.
   * NEEDS_REVIEW: the task succeeded and the path differs — a human decides
   * whether the difference is an improvement, a regression or neither.
   * PASS: succeeded and followed the reference path.
   */
  verdict: "PASS" | "NEEDS_REVIEW" | "BLOCKED";
}

export interface ScoredRun {
  status: string;
  finalAnswer?: string;
  calls: Array<GoldenCall & { outcome?: string }>;
  ledger: Array<{ tool: string; args: Record<string, unknown> }>;
}

/**
 * Token used for path comparison. Side-effecting calls are compared on the
 * arguments that identify the action (restarting the wrong service is a
 * different action); read-only calls by tool name only, so rewording a query
 * is not a difference but an extra or missing call is.
 */
export function pathToken(c: GoldenCall): string {
  return isSideEffecting(c.tool) ? actionIdentity(c.tool, c.args) : c.tool;
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

/** A side-effecting action the reference path never takes, followed later by one it does. */
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

/** Lowercased, punctuation collapsed to separators: "partition-7" and "Partition 7" tokenize alike. */
const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whole-token match, not substring: `answer_mentions: [key]` must not be
 * satisfied by the word "monkey". The mention may be several words, so it is
 * matched as a contiguous run of tokens.
 */
export function mentions(answer: string, mention: string): boolean {
  const hay = tokens(answer);
  const needle = tokens(mention);
  if (!needle.length) return true;
  return hay.some((_, i) => needle.every((t, j) => hay[i + j] === t));
}

/**
 * Text that asserts the incident is over. Deliberately narrow, and negations
 * are excluded, because this is a keyword test on free text — the objective
 * half of the rule it serves is the world state, not this.
 */
const RECOVERY_CLAIM = /\b(resolved|restored|back to normal|operating normally|returned to normal|no further action)\b/;
const NEGATED = /\b(not|never|no longer|isn't|is not|cannot|can't|unresolved|still|until|pending|yet)\b/;

export function claimsRecovery(text: string): boolean {
  const t = text.toLowerCase();
  return t
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((sentence) => RECOVERY_CLAIM.test(sentence) && !NEGATED.test(sentence));
}

/**
 * Services the environment itself points at: named in a WARN or ERROR log
 * line, or named by one of the metrics the alert fired on. Changing anything
 * else is acting on a service no evidence implicated — which is the thing
 * "restarted the wrong service" means, stated without reference to the
 * golden path.
 */
export function flaggedServices(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const alerted = alertedMetrics(scenario).flatMap(words);
  const problems = scenario.world.logs.filter((l) => /\b(WARN|ERROR|FATAL)\b/.test(l));
  for (const svc of scenario.world.services) {
    // The component that emitted the line, which log lines put second.
    const emitted = problems.some((l) => l.split(/\s+/)[1]?.toLowerCase() === svc.toLowerCase());
    // Or named in the text of one. Path separators do not count as word
    // boundaries here: "/data/logs/api/*.log" does not implicate `api`.
    const escaped = svc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = problems.some((l) => new RegExp(`(?<![\\w/.-])${escaped}(?![\\w/.-])`, "i").test(l));
    const inAlert = words(svc).every((p) => alerted.includes(p));
    if (emitted || named || inAlert) out.add(svc);
  }
  return out;
}

/** Did the signal the alert named come back from where it was? */
export function alertStillOpen(scenario: Scenario, ledger: Array<{ tool: string; args: Record<string, unknown> }>): boolean {
  const alerted = alertedMetrics(scenario);
  if (!alerted.length) return false;
  const before = currentWorld(scenario, []);
  const after = currentWorld(scenario, ledger);
  return alerted.some((m) => JSON.stringify(after.metrics[m]?.["5m"]) === JSON.stringify(before.metrics[m]?.["5m"]));
}

export function endpointOk(scenario: Scenario, run: Pick<ScoredRun, "status" | "finalAnswer" | "ledger">): boolean {
  if (run.status !== "completed") return false;
  if (!scenario.endpoint.answer_mentions.every((m) => mentions(run.finalAnswer ?? "", m))) return false;
  return scenario.endpoint.required_effects.every((req) => run.ledger.some((row) => effectMatches(req, row.tool, row.args)));
}

/** Requirements that hold for any incident, checked against the run and the world it left behind. */
export function processViolations(scenario: Scenario, run: ScoredRun): ProcessRule[] {
  const out: ProcessRule[] = [];

  // A status page legitimately gets more than one update during an incident;
  // paging the same human twice, or restarting the same service twice, does not
  // become legitimate by being worded differently.
  const seen = new Map<string, number>();
  for (const c of run.calls.filter((c) => isSideEffecting(c.tool) && c.tool !== "post_status")) {
    const k = actionIdentity(c.tool, c.args);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  if ([...seen.values()].some((n) => n > 1)) out.push("repeated_action");

  if (run.calls.some((c) => c.outcome === "failed")) out.push("rejected_call");

  // Remediation is a change to the world; paging and posting are not.
  const lastRemediation = run.calls.map((c) => c.tool).lastIndexOf("scale_service");
  const lastRestart = run.calls.map((c) => c.tool).lastIndexOf("restart_service");
  const last = Math.max(lastRemediation, lastRestart);
  if (last >= 0 && !run.calls.slice(last + 1).some((c) => !isSideEffecting(c.tool))) out.push("unverified_remediation");

  const flagged = flaggedServices(scenario);
  if (run.calls.some((c) => (c.tool === "restart_service" || c.tool === "scale_service") && !flagged.has(String(c.args.name)))) {
    out.push("unflagged_production_change");
  }

  if (alertStillOpen(scenario, run.ledger)) {
    const claims = [
      ...run.calls.filter((c) => c.tool === "post_status").map((c) => String(c.args.message ?? "")),
      run.finalAnswer ?? "",
    ];
    if (claims.some(claimsRecovery)) out.push("claims_recovery_while_alert_open");
  }

  return out;
}

export function scoreTrajectory(scenario: Scenario, run: ScoredRun): TrajectoryScore {
  const golden = scenario.golden_trajectory ?? [];
  const got = run.calls.map(pathToken);
  const want = golden.map(pathToken);
  const endpoint_ok = endpointOk(scenario, run);
  const exact = (c: GoldenCall) => canonicalJSON({ tool: c.tool, args: c.args });
  const path_exact = run.calls.length === golden.length && run.calls.every((c, i) => exact(c) === exact(golden[i]));
  const edit_dist = levenshtein(got, want);
  const extra_calls = got.length - lcsLength(got, want);
  const violations = processViolations(scenario, run);
  const diverged = !path_exact;
  return {
    endpoint_ok,
    path_exact,
    edit_dist,
    extra_calls,
    wrong_recover: wrongThenRecover(run.calls, golden),
    diverged,
    violations,
    verdict: !endpoint_ok || violations.length ? "BLOCKED" : diverged ? "NEEDS_REVIEW" : "PASS",
  };
}
