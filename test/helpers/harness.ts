import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../server/llm/configs";
import type { LLM, LlmRequest, LlmResponse } from "../../server/llm/types";
import type { AgentFactory } from "../../server/runtime/runs";
import { Store } from "../../server/store/store";

/**
 * Test double for the model. It is not a recording and never ships in the
 * app: it lets the invariant tests drive the real runtime deterministically.
 * The reply is a function of how many assistant turns the conversation
 * already has, so a resumed run gets the same reply a fresh run would.
 */
export type ScriptStep =
  | { tool: string; args: Record<string, unknown> }
  | { raw: { name: string; argsRaw: string } }
  | { final: string };

export class ScriptedLLM implements LLM {
  calls = 0;
  constructor(private script: ScriptStep[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    const s = this.script[turn];
    if (!s) throw new Error(`script exhausted at turn ${turn}`);
    if ("final" in s) return { text: s.final, tokensIn: 10, tokensOut: 5 };
    if ("raw" in s) return { text: "", toolCall: s.raw, tokensIn: 10, tokensOut: 5 };
    return { text: "", toolCall: { name: s.tool, argsRaw: JSON.stringify(s.args) }, tokensIn: 10, tokensOut: 5 };
  }
}

export function scriptedAgent(script: ScriptStep[]): { agent: AgentFactory; llm: ScriptedLLM } {
  const llm = new ScriptedLLM(script);
  const config = resolveConfig("baseline", "anthropic", "scripted-test-double");
  return { llm, agent: () => ({ config, llm }) };
}

/** A fresh database per test: Postgres when TEST_DATABASE_URL is set, otherwise a throwaway SQLite file. */
export async function freshStore(): Promise<{ store: Store; reopen: () => Promise<Store> }> {
  const url = process.env.TEST_DATABASE_URL;
  const quiet = () => {};
  if (url) {
    const store = await Store.open({ databaseUrl: url, log: quiet });
    await store.driver.exec(
      "TRUNCATE events, side_effects, naive_side_effects, eval_results, eval_runs, crash_experiments, runs RESTART IDENTITY CASCADE",
    );
    return { store, reopen: () => Store.open({ databaseUrl: url, log: quiet }) };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dar-test-"));
  const file = path.join(dir, "test.sqlite");
  return {
    store: await Store.open({ sqlitePath: file, log: quiet }),
    reopen: () => Store.open({ sqlitePath: file, log: quiet }),
  };
}

/** A plausible solution path for incident_checkout_cascade (4 side effects). */
export const CASCADE_SCRIPT: ScriptStep[] = [
  { tool: "search_logs", args: { query: "session-cache" } },
  { tool: "get_metric", args: { name: "checkout_latency_p99_ms", window: "5m" } },
  { tool: "restart_service", args: { name: "session-cache" } },
  { tool: "get_metric", args: { name: "checkout_latency_p99_ms", window: "5m" } },
  { tool: "search_logs", args: { query: "order-worker" } },
  { tool: "scale_service", args: { name: "order-worker", replicas: 8 } },
  { tool: "get_metric", args: { name: "orders_queue_depth", window: "5m" } },
  { tool: "search_logs", args: { query: "payments-gateway PSP" } },
  { tool: "page_oncall", args: { message: "PSP-2231 upstream outage causing 6% payment errors" } },
  { tool: "post_status", args: { message: "Checkout degraded; mitigations applied, payments provider incident ongoing" } },
  { final: "session-cache was OOM: restarted it. order-worker scaled to 8. Paged on-call for PSP-2231." },
];
