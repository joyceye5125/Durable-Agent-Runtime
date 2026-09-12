import { describe, expect, it } from "vitest";
import { actionIdentity, countDuplicateActions, IDENTITY_ARGS } from "../server/core/identity";
import { isSideEffecting, toolSpecs } from "../server/tools/registry";

/**
 * The duplicate counter, the trajectory scorer and the web page all ask
 * `actionIdentity` what counts as the same action. A side-effecting tool
 * missing from IDENTITY_ARGS would silently fall back to "all arguments", and
 * a second page with different wording would stop counting as a duplicate —
 * which is exactly the bug this project exists to measure.
 */
describe("action identity", () => {
  it("names every side-effecting tool and nothing else", () => {
    const sideEffecting = toolSpecs()
      .map((t) => t.name)
      .filter(isSideEffecting);
    expect(Object.keys(IDENTITY_ARGS).sort()).toEqual(sideEffecting.sort());
  });

  it("ignores free text, so rewording a page is still the same action", () => {
    const a = { tool: "page_oncall", args: { message: "checkout latency is high" } };
    const b = { tool: "page_oncall", args: { message: "Paging: checkout p99 above SLO." } };
    expect(actionIdentity(a.tool, a.args)).toBe(actionIdentity(b.tool, b.args));
    expect(countDuplicateActions([a, b])).toBe(1);
  });

  it("keeps the arguments that choose the target apart", () => {
    expect(countDuplicateActions([
      { tool: "restart_service", args: { name: "session-cache" } },
      { tool: "restart_service", args: { name: "order-worker" } },
    ])).toBe(0);
    expect(countDuplicateActions([
      { tool: "scale_service", args: { name: "order-worker", replicas: 8 } },
      { tool: "scale_service", args: { name: "order-worker", replicas: 8 } },
    ])).toBe(1);
  });
});
