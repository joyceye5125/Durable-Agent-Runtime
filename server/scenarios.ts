import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { canonicalJSON, sha256 } from "./core/canonical";

export type ArgMatcher = unknown | { gte?: number; lte?: number };

export interface EffectMatch {
  tool: string;
  /** Subset match: every listed arg must equal (or satisfy the gte/lte bound). */
  args?: Record<string, ArgMatcher>;
}

export interface WorldEffect {
  when: EffectMatch;
  /** Metric series that replace the base ones once `when` has happened. */
  metrics?: Record<string, Record<string, number[]>>;
  /** Log lines that appear once `when` has happened. */
  logs?: string[];
}

export interface World {
  services: string[];
  logs: string[];
  metrics: Record<string, Record<string, number[]>>;
  effects?: WorldEffect[];
}

export interface GoldenCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  kind: "eval" | "crash";
  task: string;
  max_steps?: number;
  world: World;
  expected_answer: string;
  endpoint: {
    /** Each string must appear (case-insensitive) in the final answer. */
    answer_mentions: string[];
    /** Each effect must be present in the run's side-effect ledger at the end. */
    required_effects: EffectMatch[];
  };
  /** Produced by `npm run record-golden` from a real baseline run and human-reviewed. */
  golden_trajectory?: GoldenCall[];
  golden_final_answer?: string;
  /**
   * "baseline": written by record-golden after review. "predicted": a
   * provisional placeholder predicted before any baseline was recorded;
   * record-golden replaces it.
   */
  golden_source?: "baseline" | "predicted";
  /**
   * Fingerprint of the task and world the golden was recorded against. Editing
   * either one makes the stored path a record of a run that can no longer
   * happen, and this is what makes that visible instead of silent.
   */
  golden_scenario_hash?: string;
}

export const SCENARIO_DIR = path.resolve(import.meta.dirname, "../scenarios");

export function scenarioPath(id: string): string {
  return path.join(SCENARIO_DIR, `${id}.yaml`);
}

export function loadScenario(id: string): Scenario {
  const file = scenarioPath(id);
  if (!fs.existsSync(file)) throw new Error(`unknown scenario "${id}"`);
  const s = YAML.parse(fs.readFileSync(file, "utf8")) as Scenario;
  if (s.id !== id) throw new Error(`scenario file ${file} declares id "${s.id}"`);
  return s;
}

export function listScenarioIds(kind?: Scenario["kind"]): string[] {
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .filter((id) => !kind || loadScenario(id).kind === kind)
    .sort();
}

/** Everything a run sees: change any of it and a recorded path no longer applies. */
export function scenarioFingerprint(s: Scenario): string {
  return sha256(canonicalJSON({ task: s.task, max_steps: s.max_steps, world: s.world })).slice(0, 16);
}

/**
 * True only for a golden that came from a reviewed baseline run of exactly
 * this scenario. A predicted placeholder, or one left behind by an edit to the
 * task or the world, is not a measurement and must not be scored against.
 */
export function goldenIsCurrent(s: Scenario): boolean {
  return !!s.golden_trajectory?.length && s.golden_source === "baseline" && s.golden_scenario_hash === scenarioFingerprint(s);
}

/** Writes the reviewed golden trajectory back into the YAML file, preserving comments and layout. */
export function writeGolden(id: string, golden: GoldenCall[], finalAnswer: string): void {
  const file = scenarioPath(id);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const flow = golden.map((c) => {
    const node = doc.createNode({ tool: c.tool, args: c.args });
    node.flow = true;
    return node;
  });
  doc.set("golden_trajectory", doc.createNode(flow));
  doc.set("golden_final_answer", finalAnswer);
  doc.set("golden_source", "baseline");
  doc.set("golden_scenario_hash", scenarioFingerprint(loadScenario(id)));
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

export function effectMatches(m: EffectMatch, tool: string, args: Record<string, unknown>): boolean {
  if (m.tool !== tool) return false;
  for (const [k, want] of Object.entries(m.args ?? {})) {
    const got = args[k];
    if (want && typeof want === "object" && !Array.isArray(want)) {
      const b = want as { gte?: number; lte?: number };
      if (typeof got !== "number") return false;
      if (b.gte !== undefined && got < b.gte) return false;
      if (b.lte !== undefined && got > b.lte) return false;
    } else if (String(got).toLowerCase() !== String(want).toLowerCase()) {
      return false;
    }
  }
  return true;
}
