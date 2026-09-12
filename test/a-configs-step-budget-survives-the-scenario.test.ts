import { describe, expect, it } from "vitest";
import { CANDIDATES, resolveConfig } from "../server/llm/configs";
import { stepBudget } from "../server/runtime/runtime";
import { listScenarioIds, loadScenario } from "../server/scenarios";

/**
 * Scenarios may raise `max_steps` because the incident is long. A candidate
 * whose whole point is a smaller budget must not be handed that raise, or the
 * candidate quietly tests nothing.
 */
describe("step budget", () => {
  const budgetCandidates = CANDIDATES.filter((c) => c.maxStepsOverride !== undefined);

  it("has a candidate that cuts it", () => {
    expect(budgetCandidates.length).toBeGreaterThan(0);
  });

  it.each(budgetCandidates.map((c) => c.label))("%s keeps its cut on every scenario", (label) => {
    const config = resolveConfig(label, "openai");
    for (const id of listScenarioIds()) {
      expect(stepBudget(config, loadScenario(id)), `${label} on ${id}`).toBe(config.maxStepsOverride);
    }
  });

  it("lets a long scenario raise the budget for configs that did not cut it", () => {
    const baseline = resolveConfig("baseline", "openai");
    const long = listScenarioIds()
      .map(loadScenario)
      .find((s) => (s.max_steps ?? 0) > baseline.maxSteps);
    expect(long, "no scenario raises max_steps above the default").toBeDefined();
    expect(stepBudget(baseline, long!)).toBe(long!.max_steps);
  });
});
