/**
 * What makes two tool calls "the same action".
 *
 * Deliberately free of node imports: the browser bundle imports this too, so
 * the duplicate the page highlights and the duplicate the experiment counts
 * are decided by one definition rather than two that can drift apart.
 */

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

/**
 * The arguments that decide *which* action a call is. A page and a status
 * update carry free text: rewording one does not make it a different action,
 * so paging twice with different wording is still paging twice.
 *
 * The keys are exactly the side-effecting tools; a test holds them to that.
 */
export const IDENTITY_ARGS: Record<string, string[]> = {
  restart_service: ["name"],
  scale_service: ["name", "replicas"],
  page_oncall: [],
  post_status: [],
};

export function actionIdentity(tool: string, args: Record<string, unknown>): string {
  const keys = IDENTITY_ARGS[tool] ?? Object.keys(args);
  return `${tool}(${canonicalJSON(Object.fromEntries(keys.map((k) => [k, args[k]])))})`;
}

/** Counts rows beyond the first for each distinct action. */
export function countDuplicateActions(rows: Array<{ tool: string; args: Record<string, unknown> }>): number {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = actionIdentity(r.tool, r.args);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].reduce((sum, c) => sum + (c - 1), 0);
}
