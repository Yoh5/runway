import { describe, expect, it } from "vitest";
import { runConformance, type ConformanceDeps } from "../../src/keeperhub/conformance.js";
import type { Address, Policy } from "../../src/policy/types.js";

const TOKEN = "0x30a6933ca9230361972e413a15dc8114c952414e" as Address;
const SENDER = "0xc4faed0e400911e44fb75e63566bf8aaaf0f7776" as Address;
const OPERATOR = "0x00000000000000000000000000000000000000aa" as Address;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;

const HASH = "0xc58483cd49462cb70e92859ce3518d10d2e6a2a7e39aaddf6f9c04af0a200d5a";

function policy(): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: TOKEN,
    sender: SENDER,
    minRunwaySec: 259_200n,
    targetRunwaySec: 604_800n,
    hysteresisSec: 86_400n,
    recipients: [
      {
        address: RECIPIENT,
        label: "crit",
        tier: "critical",
        committedRateWeiPerSec: 100n,
        floorRateWeiPerSec: 60n,
      },
    ],
    escalation: { webhook: "https://hooks.runway-ops.dev/escalations" },
  };
}

/**
 * A KeeperHub that answers the way the live deployment answered when these
 * checks were written: 401 to an anonymous execute, 404 to an unknown action,
 * and a completed execution record for an id we hold.
 */
function healthyFetch(over: Record<string, Response> = {}): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (over[href]) return over[href];
    if (href.endsWith("/api/execute/superfluid/update-flow")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (href.includes("/api/execute/superfluid/")) {
      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 404 });
    }
    if (href.endsWith("/status")) {
      return new Response(
        JSON.stringify({ executionId: "exec-1", status: "completed", transactionHash: HASH }),
        { status: 200 },
      );
    }
    return new Response("", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
}

function deps(over: Partial<ConformanceDeps> = {}): ConformanceDeps {
  return {
    fetch: healthyFetch(),
    baseUrl: "https://app.keeperhub.test",
    apiKey: "unused-in-these-tests",
    flowOperator: OPERATOR,
    getCode: async () => "0x6080604052",
    getFlowOperatorPermissions: async () => ({ permissions: 6, flowrateAllowanceWeiPerSec: 100n }),
    ...over,
  };
}

const EXECUTIONS = [{ executionId: "exec-1", transactionHash: HASH }];

const find = (checks: { name: string; ok: boolean; detail: string }[], name: string) => {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}; got ${checks.map((c) => c.name).join(", ")}`);
  return check;
};

describe("runConformance -- everything still as it was", () => {
  it("passes every check against a KeeperHub and a chain that have not moved", async () => {
    const checks = await runConformance(deps(), policy(), EXECUTIONS);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(5);
  });
});

describe("runConformance -- the KeeperHub side", () => {
  it("fails when the execute route has moved: a 404 there means our writes go nowhere", async () => {
    const fetch = healthyFetch({
      "https://app.keeperhub.test/api/execute/superfluid/update-flow": new Response("", {
        status: 404,
      }),
    });
    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);
    expect(find(checks, "keeperhub-route-exists").ok).toBe(false);
  });

  it("fails loudly when an anonymous execute is accepted, which would be a hole in KeeperHub", async () => {
    const fetch = healthyFetch({
      "https://app.keeperhub.test/api/execute/superfluid/update-flow": new Response("{}", {
        status: 200,
      }),
    });
    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);
    const check = find(checks, "keeperhub-route-exists");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/anonymous/i);
  });

  it("fails when an unknown action is not a 404, since then the 401 above proves nothing", async () => {
    const fetch = healthyFetch({
      "https://app.keeperhub.test/api/execute/superfluid/runway-conformance-probe": new Response(
        "",
        { status: 401 },
      ),
    });
    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);
    expect(find(checks, "keeperhub-unknown-action-refused").ok).toBe(false);
  });

  it("fails when a recorded execution can no longer be retrieved", async () => {
    const fetch = healthyFetch({
      "https://app.keeperhub.test/api/execute/exec-1/status": new Response("", { status: 404 }),
    });
    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);
    expect(find(checks, "keeperhub-execution-retrievable").ok).toBe(false);
  });

  it("fails when KeeperHub now reports a different transaction hash than the run recorded", async () => {
    const fetch = healthyFetch({
      "https://app.keeperhub.test/api/execute/exec-1/status": new Response(
        JSON.stringify({ executionId: "exec-1", status: "completed", transactionHash: "0xdead" }),
        { status: 200 },
      ),
    });
    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);
    const check = find(checks, "keeperhub-execution-retrievable");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/hash/i);
  });
});

describe("runConformance -- the mandate on chain", () => {
  it("fails when the treasury has revoked the mandate", async () => {
    const checks = await runConformance(
      deps({
        getFlowOperatorPermissions: async () => ({
          permissions: 0,
          flowrateAllowanceWeiPerSec: 0n,
        }),
      }),
      policy(),
      EXECUTIONS,
    );
    expect(find(checks, "mandate-permissions").ok).toBe(false);
  });

  it("fails when the mandate has been widened to include create, which the design refuses", async () => {
    const checks = await runConformance(
      deps({
        getFlowOperatorPermissions: async () => ({
          permissions: 7,
          flowrateAllowanceWeiPerSec: 100n,
        }),
      }),
      policy(),
      EXECUTIONS,
    );
    const check = find(checks, "mandate-permissions");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/7/);
  });

  it("fails when the allowance no longer covers a full restore to the committed rates", async () => {
    const checks = await runConformance(
      deps({
        getFlowOperatorPermissions: async () => ({
          permissions: 6,
          flowrateAllowanceWeiPerSec: 99n,
        }),
      }),
      policy(),
      EXECUTIONS,
    );
    expect(find(checks, "mandate-allowance").ok).toBe(false);
  });

  it("fails when the forwarder address holds no code", async () => {
    const checks = await runConformance(deps({ getCode: async () => "0x" }), policy(), EXECUTIONS);
    expect(find(checks, "forwarder-deployed").ok).toBe(false);
  });
});

describe("runConformance -- a probe that throws", () => {
  it("records the failure as a failed check rather than ending the whole run", async () => {
    const fetch = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof globalThis.fetch;

    const checks = await runConformance(deps({ fetch }), policy(), EXECUTIONS);

    expect(find(checks, "keeperhub-route-exists").ok).toBe(false);
    expect(find(checks, "keeperhub-route-exists").detail).toMatch(/socket hang up/);
    // The chain-side checks do not depend on that fetch, so they still ran.
    expect(find(checks, "mandate-permissions").ok).toBe(true);
  });
});
