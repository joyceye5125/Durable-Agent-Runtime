import { createHash } from "node:crypto";
import { canonicalJSON } from "./identity";

export { canonicalJSON };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** idem_key = sha256(run_id | step | tool_name | canonicalJSON(args)) */
export function idempotencyKey(runId: string, step: number, tool: string, args: unknown): string {
  return sha256(`${runId}|${step}|${tool}|${canonicalJSON(args)}`);
}
