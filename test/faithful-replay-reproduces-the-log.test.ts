import { describe, expect, it } from "vitest";
import { MALFORMED_OUTPUTS } from "../server/experiments/malformed";
import { faithfulReplay } from "../server/replay";
import { buildRuntime, createRun, prepareResume } from "../server/runtime/runs";
import { loadScenario } from "../server/scenarios";
import { CASCADE_SCRIPT, freshStore, scriptedAgent } from "./helpers/harness";

describe("faithful replay", () => {
  it("re-drives a crashed-and-resumed run from its log without calling the model or tools", async () => {
    const { store } = await freshStore();
    const script = [CASCADE_SCRIPT[0], { raw: MALFORMED_OUTPUTS.unknown_tool }, ...CASCADE_SCRIPT.slice(1)];
    const { agent, llm } = scriptedAgent(script);
    const id = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    await (await buildRuntime(store, id, { agent, crash: { window: "W3", target: { kind: "next_side_effect" } } })).drive();
    await prepareResume(store, id);
    await (await buildRuntime(store, id, { agent })).drive();
    const callsBefore = llm.calls;

    const replay = await faithfulReplay(await store.listEvents(id), loadScenario("incident_checkout_cascade"));

    expect(replay.identical).toBe(true);
    expect(replay.partial).toBe(false);
    expect(replay.trajectory).toHaveLength(10);
    expect(llm.calls).toBe(callsBefore);
    await store.close();
  });

  it("replays the logged prefix of a run that crashed and was never resumed", async () => {
    const { store } = await freshStore();
    const { agent } = scriptedAgent(CASCADE_SCRIPT);
    const id = await createRun(store, { scenario: "incident_checkout_cascade", mode: "durable" }, { agent });
    await (await buildRuntime(store, id, { agent, crash: { window: "W3", target: { kind: "next_side_effect" } } })).drive();
    const replay = await faithfulReplay(await store.listEvents(id), loadScenario("incident_checkout_cascade"));
    expect(replay).toMatchObject({ identical: true, partial: true });
    await store.close();
  });
});
