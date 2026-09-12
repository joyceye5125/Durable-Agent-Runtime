import { describe, expect, it } from "vitest";
import { goldenIsCurrent, listScenarioIds, loadScenario, scenarioFingerprint } from "../server/scenarios";

/**
 * A golden trajectory is a record of one real run. Edit the task text or the
 * world afterwards and the stored path describes a run that can no longer
 * happen — but it would keep being scored against, silently, because nothing
 * about it looks wrong. The fingerprint written next to it is what makes that
 * edit visible; this test is what makes it visible now rather than in a
 * result table.
 *
 * If it fails, re-record the scenarios it names:
 *   npm run record-golden -- --all
 */
const scenarios = listScenarioIds().map(loadScenario);

describe("golden trajectories", () => {
  const reviewed = scenarios.filter((s) => s.golden_source === "baseline");

  it.each(reviewed.map((s) => s.id))("%s still matches the scenario it was recorded from", (id) => {
    const s = loadScenario(id);
    expect(s.golden_scenario_hash, "recorded before fingerprints existed").toBeDefined();
    expect(s.golden_scenario_hash).toBe(scenarioFingerprint(s));
  });

  it("treats a predicted placeholder as not measured", () => {
    for (const s of scenarios.filter((x) => x.golden_source === "predicted")) {
      expect(goldenIsCurrent(s), `${s.id} is predicted but counted as reviewed`).toBe(false);
    }
  });

  it("changes the fingerprint when the world changes", () => {
    const s = scenarios[0];
    const edited = { ...s, world: { ...s.world, logs: [...s.world.logs, "2026-09-10T00:00:00Z api INFO extra line"] } };
    expect(scenarioFingerprint(edited)).not.toBe(scenarioFingerprint(s));
  });
});
