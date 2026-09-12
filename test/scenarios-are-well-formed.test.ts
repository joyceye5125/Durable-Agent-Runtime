import { describe, expect, it } from "vitest";
import { listScenarioIds, loadScenario, type Scenario } from "../server/scenarios";
import { currentWorld, getTool, runTool } from "../server/tools/registry";

/**
 * Scenario bugs look like agent failures: a live baseline run burned its whole
 * step budget because one log line was unsearchable and one remediation had no
 * visible effect. These checks catch that class before an API key is spent.
 */
const scenarios: Scenario[] = listScenarioIds().map(loadScenario);

describe.each(scenarios.map((s) => [s.id, s] as const))("%s", (_id, s) => {
  it("alerts name metrics that exist in the world", () => {
    for (const m of [...s.task.matchAll(/ALERT ([a-z_][a-z0-9_]*)/g)].map((x) => x[1])) {
      expect(Object.keys(s.world.metrics), `task names metric "${m}"`).toContain(m);
    }
  });

  it("answers at both windows an agent is likely to ask for", () => {
    for (const [name, windows] of Object.entries(s.world.metrics)) {
      expect(Object.keys(windows), `metric ${name}`).toEqual(expect.arrayContaining(["5m", "1h"]));
    }
  });

  it("targets services that exist, and their evidence is findable by searching the service name", () => {
    const world = currentWorld(s, []);
    for (const effect of s.endpoint.required_effects) {
      const name = effect.args?.name;
      if (name === undefined) continue;
      expect(s.world.services).toContain(String(name));
      const found = runTool("search_logs", { query: String(name) }, world) as { matches: string[] };
      expect(found.matches.length, `search_logs("${name}") finds nothing`).toBeGreaterThan(0);
    }
  });

  it("makes an under-sized scale-out visible instead of silent", () => {
    const thresholds = new Map<string, number[]>();
    for (const e of triggersOf(s)) {
      const replicas = e.args?.replicas as { gte?: number } | undefined;
      if (e.tool !== "scale_service" || !replicas?.gte) continue;
      const key = String(e.args?.name);
      thresholds.set(key, [...(thresholds.get(key) ?? []), replicas.gte]);
    }
    for (const [service, gtes] of thresholds) {
      // Scaling one step above the current replica count has to change
      // something, or the agent polls a metric that will never move.
      expect(Math.min(...gtes), `${service}: the lowest scale threshold is too high to ever be hit by a cautious step`).toBeLessThanOrEqual(5);
    }
  });

  it("only requires tools that exist, and every effect targets a real service", () => {
    for (const e of [...s.endpoint.required_effects, ...triggersOf(s)]) {
      expect(getTool(e.tool), `unknown tool ${e.tool}`).toBeDefined();
      if (e.args?.name !== undefined) expect(s.world.services).toContain(String(e.args.name));
    }
  });

  /**
   * The agent checks the window that means "just now". An effect that only
   * moves the 1h series looks, at 5m, exactly like a remediation that did
   * nothing — and the operating policy tells the agent to keep working until
   * the alert recovers, so it will act again instead of finishing.
   */
  it("recovers in the 5m window, not only in the long ones", () => {
    for (const e of s.world.effects ?? []) {
      for (const [metric, series] of Object.entries(e.metrics ?? {})) {
        expect(Object.keys(series), `effect -> ${metric}`).toContain("5m");
      }
    }
  });

  it("lets the agent see the alert clear, or is an escalation incident", () => {
    // The crash scenario is deliberately a partly-unfixable incident: it ends
    // in a page, and it is scored on crash recovery, not on solving it.
    const escalateOnly = s.kind === "crash" || s.endpoint.required_effects.every((e) => e.tool === "page_oncall");
    if (escalateOnly) return;
    const alerted = alertedMetrics(s);
    expect(alerted.length, "task names no metric that exists").toBeGreaterThan(0);
    const before = currentWorld(s, []);
    const after = currentWorld(s, s.endpoint.required_effects.map((e) => ({ tool: e.tool, args: liftArgs(e.args) })));
    for (const m of alerted) {
      expect(after.metrics[m]?.["5m"], `${m} reads the same at 5m after the fix`).not.toEqual(before.metrics[m]?.["5m"]);
    }
  });

  /**
   * An incident that requires two remediations has to look unfixed after
   * either one on its own. Otherwise the agent does half, sees the alert
   * clear, and stops — correctly, by its own evidence — and the scenario is
   * asking for something the readings never justify.
   */
  it("does not look solved after only part of a multi-step remediation", () => {
    const req = s.endpoint.required_effects;
    // Again not the crash scenario: it is not scored on being solved, and its
    // reference run is what C1 measures.
    if (s.kind === "crash" || req.length < 2) return;
    const alerted = alertedMetrics(s);
    const base = currentWorld(s, []);
    for (const left of req) {
      const partial = currentWorld(s, [{ tool: left.tool, args: liftArgs(left.args) }]);
      const stillAlerting = alerted.filter((m) => JSON.stringify(partial.metrics[m]?.["5m"]) === JSON.stringify(base.metrics[m]?.["5m"]));
      expect(stillAlerting.length, `after ${left.tool} alone, every alerting metric has moved: nothing tells the agent it is not done`).toBeGreaterThan(0);
    }
  });

  it("can be solved: the required remediation changes what the agent reads", () => {
    const before = currentWorld(s, []);
    const ledger = s.endpoint.required_effects.map((e) => ({ tool: e.tool, args: liftArgs(e.args) }));
    const after = currentWorld(s, ledger);
    const readsChange = JSON.stringify(after.metrics) !== JSON.stringify(before.metrics) || after.logs.length !== before.logs.length;
    // Escalate-only incidents legitimately leave the world unchanged.
    const escalateOnly = s.endpoint.required_effects.every((e) => e.tool === "page_oncall");
    expect(readsChange || escalateOnly, "required remediation has no observable effect").toBe(true);
  });
});

/** The metrics the alert itself names: the ones the agent will check to decide it is done. */
function alertedMetrics(s: Scenario): string[] {
  return [...s.task.matchAll(/ALERT ([a-z_][a-z0-9_]*)|and ([a-z_][a-z0-9_]*) = /g)]
    .flatMap((m) => [m[1], m[2]])
    .filter((x): x is string => !!x && x in s.world.metrics);
}

/** Every matcher an effect waits on, whether it waits on one or on all of several. */
function triggersOf(s: Scenario) {
  return (s.world.effects ?? []).flatMap((e) => e.when_all ?? (e.when ? [e.when] : []));
}

/** `{ replicas: { gte: 6 } }` describes a class of calls; a ledger row holds one concrete call. */
function liftArgs(args: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, v && typeof v === "object" && "gte" in (v as object) ? (v as { gte: number }).gte : v]),
  );
}
