import { resolveConfig } from "../llm/configs";
import { hasRecording, loadRecording } from "../llm/recording";
import { goldenIsCurrent, type Scenario } from "../scenarios";

/**
 * A golden trajectory counts as a measurement only if all three still hold:
 * a human reviewed it, the scenario it was recorded against has not changed
 * since, and the baseline that produced it is the baseline in the tree now.
 * Edit the baseline prompt and every golden silently becomes the output of a
 * configuration that no longer exists — this is what notices.
 */
export function goldenIsUsable(s: Scenario): boolean {
  if (!goldenIsCurrent(s)) return false;
  if (!hasRecording("baseline", s.id)) return false;
  const file = loadRecording("baseline", s.id);
  return resolveConfig("baseline", file.provider, file.model).hash === file.config_hash;
}
