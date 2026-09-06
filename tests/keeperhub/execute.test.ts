import { describe, expect, it } from "vitest";
import { executeAdjustment } from "../../src/keeperhub/execute.js";
import type { ExecutorDeps, SimulateFn } from "../../src/keeperhub/execute.js";
import { idempotencyKey } from "../../src/keeperhub/idempotency.js";
import type { Address, Adjustment, Policy } from "../../src/policy/types.js";

function policy(): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

function adjustment(): Adjustment {
  return {
    receiver: "0x1111111111111111111111111111111111111111" as Address,
    fromRateWeiPerSec: 100n,
    toRateWeiPerSec: 50n,
    reason: "budget-shed",
  };
}

const NOW = 1_700_000_000;

/** Local viem-style simulation stub: never touches the network. */
function okSimulate(): SimulateFn {
  return async () => ({ reverted: false });
}

function revertingSimulate(reason: string): SimulateFn {
  return async () => ({ reverted: true, reason });
}

type Call = { body: Record<string, unknown>; key: string | null };

/**
 * Builds a fresh scripted `fetch` for the KeeperHub broadcast POST only —
 * `deps.simulate` never goes through fetch, per the controller's correction
 * that the catch-all protocol route ignores an unrecognised `simulate` field.
 * `scripted` entries are consumed in order, then the last one repeats, so a
 * retry loop can be driven without growing the array.
 */
function stub(calls: Call[], scripted: [number, unknown][]): typeof globalThis.fetch {
  let index = 0;
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const key = new Headers(init?.headers).get("Idempotency-Key");
    calls.push({ body, key });
    const entry = scripted[index] ?? scripted.at(-1);
    index++;
    if (!entry) throw new Error("no scripted response");
    return new Response(JSON.stringify(entry[1]), { status: entry[0] });
  }) as typeof globalThis.fetch;
}

function baseDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    baseUrl: "https://keeperhub.test",
    apiKey: "kh_test",
    pollBudgetMs: 2_000,
    sleep: async () => {},
    simulate: okSimulate(),
    fetch: (async () => {
      throw new Error("fetch should not be called");
    }) as typeof globalThis.fetch,
    ...overrides,
  };
}

const LANDED_BODY = {
  success: true,
  transactionHash: "0xabc",
  transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
  gasUsed: "21000",
  effectiveGasPrice: "1000000000",
  sponsored: true,
};

describe("executeAdjustment", () => {
  it("simulates locally and refuses to broadcast when the simulation would revert", async () => {
    const calls: Call[] = [];
    const outcome = await executeAdjustment(
      baseDeps({
        simulate: revertingSimulate("CFA: ACL denied"),
        fetch: stub(calls, [[200, LANDED_BODY]]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome).toMatchObject({ status: "refused", stage: "simulate", detail: "CFA: ACL denied" });
    expect(calls).toHaveLength(0);
  });

  it("never sends a simulate flag to KeeperHub — the catch-all route ignores it, it does not refuse it", async () => {
    const calls: Call[] = [];
    await executeAdjustment(
      baseDeps({ fetch: stub(calls, [[200, LANDED_BODY]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).not.toHaveProperty("simulate");
  });

  it("posts chainId, token, sender, receiver, flowRate and userData", async () => {
    const calls: Call[] = [];
    await executeAdjustment(
      baseDeps({ fetch: stub(calls, [[200, LANDED_BODY]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(calls[0]?.body).toEqual({
      chainId: 11155111,
      token: "0x0000000000000000000000000000000000000aaa",
      sender: "0x0000000000000000000000000000000000000bbb",
      receiver: "0x1111111111111111111111111111111111111111",
      flowRate: "50",
      userData: "0x",
    });
  });

  it("carries an Idempotency-Key header matching idempotencyKey(policy, adjustment, nowSec)", async () => {
    const calls: Call[] = [];
    await executeAdjustment(
      baseDeps({ fetch: stub(calls, [[200, LANDED_BODY]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(calls[0]?.key).toBe(idempotencyKey(policy(), adjustment(), NOW));
    expect(calls[0]?.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reports landed with the transaction hash, link, gas and sponsorship flag on success: true", async () => {
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, LANDED_BODY]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome).toEqual({
      status: "landed",
      transactionHash: "0xabc",
      transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
      gasUsedWei: "21000",
      effectiveGasPriceWei: "1000000000",
      sponsored: true,
    });
  });

  it("never reports landed when success is true but transactionHash is missing or non-string", async () => {
    const missingHash = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, { success: true }]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(missingHash.status).toBe("unresolved");

    const numericHash = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, { success: true, transactionHash: 12345 }]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(numericHash.status).toBe("unresolved");
  });

  it("refuses on success: false, folding error and rejection into the detail", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub([], [[200, { success: false, error: "insufficient allowance", rejection: "CFA_ACL_NO_SENDER_CREATE_PERMISSIONS" }]]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome).toEqual({
      status: "refused",
      stage: "broadcast",
      detail: "insufficient allowance: CFA_ACL_NO_SENDER_CREATE_PERMISSIONS",
    });
  });

  it("retries a 409 idempotency_in_progress with the identical key and lands once it clears", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub(calls, [[409, { code: "idempotency_in_progress", retryable: true }], [200, LANDED_BODY]]),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("landed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("reports unresolved once idempotency_in_progress exhausts the retry budget", async () => {
    const calls: Call[] = [];
    const outcome = await executeAdjustment(
      baseDeps({
        pollBudgetMs: 500,
        fetch: stub(calls, [[409, { code: "idempotency_in_progress", retryable: true }]]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
    expect(calls.length).toBeGreaterThan(0);
    // Every retry must still carry the same key: rotating it here could
    // broadcast a second transaction for work that may already be live.
    const keys = new Set(calls.map((c) => c.key));
    expect(keys.size).toBe(1);
  });

  it("refuses on 409 idempotency_conflict and never retries or rotates the key", async () => {
    const calls: Call[] = [];
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub(calls, [
          [409, { code: "idempotency_conflict", retryable: false, originalExecutionId: "direct_0" }],
        ]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.stage).toBe("broadcast");
    expect(calls).toHaveLength(1);
  });

  it("never puts the API key in an idempotency_conflict outcome, even when the server echoes it in originalExecutionId", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub([], [
          [
            409,
            {
              code: "idempotency_conflict",
              retryable: false,
              originalExecutionId: "direct_0 kh_test leaked-by-server",
            },
          ],
        ]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain("kh_test");
  });

  it("reports unresolved when the broadcast request itself throws", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: (async () => {
          throw new Error("ECONNRESET");
        }) as typeof globalThis.fetch,
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
  });

  it("reports unresolved on a response body it does not recognise, rather than guessing", async () => {
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, { weird: "shape" }]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
  });

  it("refuses on a 401 whose body carries a bare error string with no success field", async () => {
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[401, { error: "Missing Authorization header" }]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome).toEqual({
      status: "refused",
      stage: "broadcast",
      detail: "Missing Authorization header",
    });
  });

  it("reports unresolved when the broadcast response body is not valid JSON", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as typeof globalThis.fetch,
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
  });

  it("redacts a hosted RPC provider's key out of a simulate revert reason too (I4)", async () => {
    // deps.simulate is a real viem client in production (built in cli.ts)
    // reading against the RPC endpoint; its thrown errors can embed a hosted
    // provider's key baked into the URL path, and that text lands directly
    // in `simulation.reason`, which this module returns as the "refused"
    // outcome's detail.
    const FAKE_RPC_KEY = "sk-fake-provider-key-should-never-leak-9f3a";
    const rpcUrl = `https://eth-sepolia.g.alchemy.com/v2/${FAKE_RPC_KEY}`;
    const outcome = await executeAdjustment(
      baseDeps({
        rpcUrl,
        simulate: revertingSimulate(`CFA: ACL denied (request to ${rpcUrl} failed)`),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain(FAKE_RPC_KEY);
    expect(JSON.stringify(outcome)).toContain("[redacted]");
  });

  it("never puts the API key in any outcome", async () => {
    const outcomes = await Promise.all([
      executeAdjustment(
        baseDeps({ simulate: revertingSimulate("nope") }),
        policy(),
        adjustment(),
        NOW,
      ),
      executeAdjustment(
        baseDeps({ fetch: stub([], [[200, { success: false, error: "boom" }]]) }),
        policy(),
        adjustment(),
        NOW,
      ),
      executeAdjustment(
        baseDeps({
          fetch: (async () => {
            throw new Error("socket error, key kh_test leaked in a naive implementation");
          }) as typeof globalThis.fetch,
        }),
        policy(),
        adjustment(),
        NOW,
      ),
    ]);
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain("kh_test");
    }
  });
});
