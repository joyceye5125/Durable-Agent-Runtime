import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getConfig, resolveConfig } from "../server/llm/configs";
import { loadRecording, RECORDINGS_DIR } from "../server/llm/recording";
import { listScenarioIds } from "../server/scenarios";

/**
 * A recording is keyed by the config that produced it: edit a prompt, a tool
 * description or a step budget and every recording made with that config
 * becomes unreplayable, which costs real money to redo. This test fails the
 * moment such an edit lands, instead of at the next replay.
 *
 * If it fails on purpose (the config change is wanted), re-record that config:
 *   npm run record -- --config <label> --fresh
 */
const recorded = fs.existsSync(RECORDINGS_DIR)
  ? fs
      .readdirSync(RECORDINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        fs
          .readdirSync(`${RECORDINGS_DIR}/${d.name}`)
          .filter((f) => f.endsWith(".json"))
          .map((f) => [d.name, f.replace(/\.json$/, "")] as const),
      )
  : [];

describe.skipIf(recorded.length === 0)("committed recordings", () => {
  it.each(recorded)("%s/%s still matches the current config", (label, task) => {
    const file = loadRecording(label, task);
    expect(getConfig(label), `recording for unknown config "${label}"`).toBeDefined();
    expect(resolveConfig(label, file.provider, file.model).hash).toBe(file.config_hash);
  });

  it("only covers tasks that still exist", () => {
    const ids = new Set(listScenarioIds());
    for (const [, task] of recorded) expect(ids, `recording for unknown scenario "${task}"`).toContain(task);
  });
});
