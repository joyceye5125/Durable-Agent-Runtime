import { describe, expect, it } from "vitest";
import { idempotencyKey } from "../server/core/canonical";
import { DbToolExecutor } from "../server/runtime/executor";
import { loadScenario } from "../server/scenarios";
import { freshStore } from "./helpers/harness";

describe("exactly-once side effects", () => {
  it("executing the same idem_key twice leaves exactly one side_effects row", async () => {
    const { store } = await freshStore();
    const scenario = loadScenario("incident_checkout_cascade");
    await store.createRun({ id: "r1", scenario: scenario.id, mode: "durable", configLabel: "baseline" });
    const tools = new DbToolExecutor(store, "r1", "durable", scenario);
    const args = { name: "session-cache" };
    const call = { step: 2, tool: "restart_service", args, idemKey: idempotencyKey("r1", 2, "restart_service", args) };

    const first = await tools.invoke(call);
    const second = await tools.invoke(call);

    expect(first).toEqual({ ok: true, result: { status: "restarted", service: "session-cache" } });
    expect(second).toEqual(first);
    const rows = await store.listSideEffects("r1");
    expect(rows).toHaveLength(1);
    expect(rows[0].idem_key).toBe(call.idemKey);
    await store.close();
  });

  it("a different step with the same args is a different logical side effect", async () => {
    const { store } = await freshStore();
    const scenario = loadScenario("incident_checkout_cascade");
    await store.createRun({ id: "r2", scenario: scenario.id, mode: "durable", configLabel: "baseline" });
    const tools = new DbToolExecutor(store, "r2", "durable", scenario);
    const args = { message: "degraded" };
    await tools.invoke({ step: 3, tool: "post_status", args, idemKey: idempotencyKey("r2", 3, "post_status", args) });
    await tools.invoke({ step: 7, tool: "post_status", args, idemKey: idempotencyKey("r2", 7, "post_status", args) });
    expect(await store.listSideEffects("r2")).toHaveLength(2);
    await store.close();
  });
});
