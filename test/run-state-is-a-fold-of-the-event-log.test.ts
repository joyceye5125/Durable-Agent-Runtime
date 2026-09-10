import { describe, expect, it } from "vitest";
import { fold, trajectoryOf } from "../server/core/events";
import { buildRuntime, createRun } from "../server/runtime/runs";
import { CASCADE_SCRIPT, freshStore, scriptedAgent } from "./helpers/harness";

describe("run state", () => {
  it("is fully recoverable from the event log alone", async () => {
    const { store, reopen } = await freshStore();
    const { agent } = scriptedAgent(CASCADE_SCRIPT);
    const runId = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    const outcome = await (await buildRuntime(store, runId, { agent })).drive();
    expect(outcome.status).toBe("completed");
    await store.close();

    // A second connection with no shared process state sees the same run.
    const other = await reopen();
    const state = fold(await other.listEvents(runId));
    expect(state.status).toBe("completed");
    expect(state.finalAnswer).toContain("session-cache");
    const path = trajectoryOf(state).map((c) => c.tool);
    expect(path).toEqual(CASCADE_SCRIPT.flatMap((s) => ("tool" in s ? [s.tool] : [])));
    expect(trajectoryOf(state).every((c) => c.outcome === "committed")).toBe(true);
    await other.close();
  });

  it("feeds world state from the ledger: a remediation changes later reads", async () => {
    const { store } = await freshStore();
    const { agent } = scriptedAgent(CASCADE_SCRIPT);
    const runId = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    await (await buildRuntime(store, runId, { agent })).drive();
    const state = fold(await store.listEvents(runId));
    const before = state.steps[1].outcome;
    const after = state.steps[3].outcome;
    expect(before).toMatchObject({ kind: "committed", result: { values: [4100, 4600, 4800] } });
    expect(after).toMatchObject({ kind: "committed", result: { values: [4800, 2100, 640] } });
    await store.close();
  });
});
