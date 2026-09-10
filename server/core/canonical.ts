import { createHash } from "node:crypto";

/** Key-sorted, whitespace-free JSON: the identity used for hashing and comparing args. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** idem_key = sha256(run_id | step | tool_name | canonicalJSON(args)) */
export function idempotencyKey(runId: string, step: number, tool: string, args: unknown): string {
  return sha256(`${runId}|${step}|${tool}|${canonicalJSON(args)}`);
}
