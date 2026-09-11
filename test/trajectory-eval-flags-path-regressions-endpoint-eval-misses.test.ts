import { describe, expect, it } from "vitest";
import { runEvalExperiment } from "../server/eval/experiment";
import { levenshtein, scoreTrajectory, wrongThenRecover } from "../server/eval/trajectory";
import { resolveConfig } from "../server/llm/configs";
import type { AgentFactory } from "../server/runtime/runs";
import { loadScenario, type Scenario } from "../server/scenarios";
import { freshStore, ScriptedLLM, type ScriptStep } from "./helpers/harness";

// Test fixture only. Real golden trajectories come from `npm run record-golden`.
const GOLDEN: ScriptStep[] = [
  { tool: "search_logs", args: { query: "disk /data" } },
  { tool: "restart_service", args: { name: "log-rotator" } },
  { tool: "get_metric", args: { name: "disk_usage_data", window: "5m" } },
  { tool: "post_status", args: { message: "disk mitigated" } },
  { final: "log-rotator had a stale lock; restarted it and /data recovered" },
];
const task: Scenario = {
  ...loadScenario("incident_disk_full"),
  golden_trajectory: GOLDEN.flatMap((s) => ("tool" in s ? [{ tool: s.tool, args: s.args }] : [])),
};

const REDUNDANT: ScriptStep[] = [GOLDEN[0], { tool: "search_logs", args: { query: "log-rotator lock" } }, ...GOLDEN.slice(1)];
const WRONG_THEN_RIGHT: ScriptStep[] = [GOLDEN[0], { tool: "restart_service", args: { name: "api" } }, ...GOLDEN.slice(1)];
const SKIPS_REMEDIATION: ScriptStep[] = [GOLDEN[0], { final: "log-rotator is failing; someone should look at it" }];

const scripts: Record<string, ScriptStep[]> = {
  baseline: GOLDEN,
  "double-check": REDUNDANT,
  "act-fast": WRONG_THEN_RIGHT,
  "no-escalation": SKIPS_REMEDIATION,
};
const agent: AgentFactory = (label) => ({ config: resolveConfig(label, "anthropic", "scripted"), llm: new ScriptedLLM(scripts[label]) });

describe("trajectory eval", () => {
  it("scores edit distance on side-effect targets, not on query or message wording", () => {
    const reworded = task.golden_trajectory!.map((c) =>
      c.tool === "search_logs" ? { ...c, args: { query: "data partition" } } : c.tool === "post_status" ? { ...c, args: { message: "resolved" } } : c,
    );
    const s = scoreTrajectory(task, { status: "completed", finalAnswer: "log-rotator restarted", calls: reworded, ledger: [{ tool: "restart_service", args: { name: "log-rotator" } }] });
    expect(s).toMatchObject({ endpoint_ok: true, path_exact: false, edit_dist: 0, extra_calls: 0, path_regressed: false });
    expect(levenshtein(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(wrongThenRecover(WRONG_THEN_RIGHT.flatMap((s) => ("tool" in s ? [s] : [])), task.golden_trajectory!)).toBe(true);
  });

  it("flags changes whose answers stay correct but whose path degrades, which endpoint eval passes", async () => {
    const { store } = await freshStore();
    const summary = await runEvalExperiment(store, { labels: Object.keys(scripts), agent, tasks: [task] });
    const by = Object.fromEntries(summary.changes.map((c) => [c.label, c]));

    expect(by.baseline).toMatchObject({ endpointPass: 1, pathOnlyRegressions: 0, trajectoryVerdict: "PASS" });
    expect(by["double-check"]).toMatchObject({ endpointVerdict: "PASS", trajectoryVerdict: "BLOCKED", extraCalls: 1 });
    expect(by["act-fast"]).toMatchObject({ endpointVerdict: "PASS", trajectoryVerdict: "BLOCKED", wrongRecover: 1 });
    expect(by["no-escalation"]).toMatchObject({ endpointVerdict: "BLOCKED", trajectoryVerdict: "BLOCKED", pathOnlyRegressions: 0 });
    expect(summary.missedByEndpoint).toBe(2);
    expect(summary.pathOnlyRows).toBe(2);
    await store.close();
  });
});
