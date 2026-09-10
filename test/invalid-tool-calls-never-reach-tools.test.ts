import { describe, expect, it } from "vitest";
import { MALFORMED_OUTPUTS } from "../server/experiments/malformed";
import { buildRuntime, createRun } from "../server/runtime/runs";
import { freshStore, scriptedAgent, type ScriptStep } from "./helpers/harness";

describe("invalid tool calls", () => {
  it("hallucinated tools, bad JSON and schema violations are rejected without TOOL_INVOKED or side effects", async () => {
    const { store } = await freshStore();
    const script: ScriptStep[] = [
      { raw: MALFORMED_OUTPUTS.unknown_tool },
      { raw: MALFORMED_OUTPUTS.invalid_json },
      { tool: "search_logs", args: { query: "session-cache" } },
      { raw: MALFORMED_OUTPUTS.schema_violation },
      { tool: "restart_service", args: { name: "session-cache" } },
      { final: "restarted session-cache" },
    ];
    const { agent } = scriptedAgent(script);
    const id = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    const out = await (await buildRuntime(store, id, { agent })).drive();
    expect(out.status).toBe("completed");

    const events = await store.listEvents(id);
    const rejected = events.filter((e) => e.kind === "TOOL_REJECTED").map((e) => e.step);
    expect(rejected).toEqual([0, 1, 3]);
    const invokedSteps = events.filter((e) => e.kind === "TOOL_INVOKED").map((e) => e.step);
    expect(invokedSteps).toEqual([2, 4]);
    const ledger = await store.listSideEffects(id);
    expect(ledger.map((r) => r.step)).toEqual([4]);
    await store.close();
  });

  it("more than max_invalid_retries consecutive invalid calls fail the run cleanly with zero side effects", async () => {
    const { store } = await freshStore();
    const bad = { raw: MALFORMED_OUTPUTS.schema_violation };
    const { agent, llm } = scriptedAgent([bad, bad, bad, { tool: "restart_service", args: { name: "session-cache" } }]);
    const before = await store.countAllSideEffects();
    const id = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    const out = await (await buildRuntime(store, id, { agent })).drive();

    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/invalid tool-call retries/) });
    expect(llm.calls).toBe(3);
    expect(await store.countAllSideEffects()).toBe(before);
    expect((await store.listEvents(id)).some((e) => e.kind === "TOOL_INVOKED")).toBe(false);
    await store.close();
  });
});
