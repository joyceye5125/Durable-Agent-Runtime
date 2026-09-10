import { describe, expect, it } from "vitest";
import { CRASH_WINDOWS, type CrashPlan } from "../server/runtime/crash";
import { buildRuntime, createRun, prepareResume } from "../server/runtime/runs";
import type { Runtime } from "../server/runtime/runtime";
import { CASCADE_SCRIPT, freshStore, scriptedAgent } from "./helpers/harness";

const SCENARIO = "incident_checkout_cascade";

async function referenceRun() {
  const { store } = await freshStore();
  const { agent } = scriptedAgent(CASCADE_SCRIPT);
  const id = await createRun(store, { scenario: SCENARIO, mode: "durable" }, { agent });
  const out = await (await buildRuntime(store, id, { agent })).drive();
  const ledger = (await store.listSideEffects(id)).map((r) => [r.step, r.tool, r.args]);
  await store.close();
  return { out, ledger };
}

describe("resume after an injected crash", () => {
  for (const window of CRASH_WINDOWS) {
    it(`${window}: a fresh Runtime built from the log finishes with the no-crash result and no duplicate side effect`, async () => {
      const ref = await referenceRun();
      const { store, reopen } = await freshStore();
      const { agent } = scriptedAgent(CASCADE_SCRIPT);
      const plan: CrashPlan = { window, target: { kind: "tool_call", index: 5 } }; // scale_service

      const id = await createRun(store, { scenario: SCENARIO, mode: "durable" }, { agent });
      let runtime: Runtime | null = await buildRuntime(store, id, { agent, crash: plan });
      const crashed = await runtime.drive();
      expect(crashed.status).toBe("crashed");
      await expect(runtime.drive()).rejects.toThrow(/crashed/);

      // Drop every in-memory object from before the crash, including the DB
      // connection, and resume with a Runtime whose only input is the database.
      runtime = null;
      await store.close();
      const fresh = await reopen();
      await prepareResume(fresh, id);
      const resumed = await (await buildRuntime(fresh, id, { agent })).drive();

      expect(resumed).toEqual(ref.out);
      const ledger = (await fresh.listSideEffects(id)).map((r) => [r.step, r.tool, r.args]);
      expect(ledger).toEqual(ref.ledger);
      await fresh.close();
    });
  }

  it("W3 on the naive baseline re-executes the side effect: the ledger gains a duplicate row", async () => {
    const { store } = await freshStore();
    const { agent } = scriptedAgent(CASCADE_SCRIPT);
    const plan: CrashPlan = { window: "W3", target: { kind: "next_side_effect" } };

    const durableId = await createRun(store, { scenario: SCENARIO, mode: "durable" }, { agent });
    await (await buildRuntime(store, durableId, { agent, crash: plan })).drive();
    await prepareResume(store, durableId);
    await (await buildRuntime(store, durableId, { agent })).drive();

    const naiveId = await createRun(store, { scenario: SCENARIO, mode: "naive" }, { agent });
    await (await buildRuntime(store, naiveId, { agent, crash: plan })).drive();
    await prepareResume(store, naiveId);
    await (await buildRuntime(store, naiveId, { agent })).drive();

    const durable = await store.listSideEffects(durableId);
    const naive = await store.listNaiveSideEffects(naiveId);
    expect(durable).toHaveLength(4);
    expect(naive).toHaveLength(5);
    expect(naive.filter((r) => r.tool === "restart_service")).toHaveLength(2);
    await store.close();
  });
});
