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

  it("leaves sponsored undefined when an ordinary (non-Turnkey-Gas-Station) response omits it, rather than defaulting to false", async () => {
    const { sponsored: _omit, ...unsponsoredBody } = LANDED_BODY;
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, unsponsoredBody]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("landed");
    if (outcome.status === "landed") {
      expect(outcome.sponsored).toBeUndefined();
      expect("sponsored" in outcome).toBe(false);
    }
  });

  it("reports sponsored: false as-is when the response explicitly says so", async () => {
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, { ...LANDED_BODY, sponsored: false }]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("landed");
    if (outcome.status === "landed") expect(outcome.sponsored).toBe(false);
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

  it("reports unresolved rather than refused on success: false when a transactionHash is present (a hash means the transaction reached the chain, and completeExecution/failExecution can both report unconfirmed as success: false)", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub(
          [],
          [[200, { success: false, error: "confirmation timed out", transactionHash: "0xdeadbeef" }]],
        ),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
    if (outcome.status === "unresolved") {
      expect(outcome.transactionHash).toBe("0xdeadbeef");
      expect(outcome.detail).toContain("0xdeadbeef");
    }
  });

  it("still refuses on success: false with a non-string transactionHash — that is not a hash a human can look up", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub([], [[200, { success: false, error: "boom", transactionHash: 12345 }]]),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("refused");
  });

  it("never puts the API key in an unresolved-with-hash outcome", async () => {
    const outcome = await executeAdjustment(
      baseDeps({
        fetch: stub(
          [],
          [[200, { success: false, error: "boom kh_test leaked", transactionHash: "0xdeadbeef" }]],
        ),
      }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("unresolved");
    expect(JSON.stringify(outcome)).not.toContain("kh_test");
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

  // -- New KeeperHub contract (staging): the response carries a `status`
  // field instead of `success`, and always carries `executionId`. Verified
  // against `app/api/execute/[...slug]/route.ts` on `origin/staging`. Two
  // things did NOT change: no `simulate` support, and a response still means
  // the write reached the broadcast path (not a queued job) -- the new
  // contract just answers 202 instead of 200. Whether the live deployment at
  // app.keeperhub.com has caught up with `staging` is unknown, so both
  // shapes must be handled -- see the old-shape tests above, kept untouched.
  describe("new contract (status field, no success field)", () => {
    it("reports landed on status: completed with a transactionHash, tagging contract: 'status' and carrying executionId", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub(
            [],
            [
              [
                202,
                {
                  executionId: "exec_123",
                  status: "completed",
                  transactionHash: "0xnew",
                  transactionLink: "https://sepolia.etherscan.io/tx/0xnew",
                },
              ],
            ],
          ),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome).toMatchObject({
        status: "landed",
        transactionHash: "0xnew",
        transactionLink: "https://sepolia.etherscan.io/tx/0xnew",
        contract: "status",
        executionId: "exec_123",
      });
    });

    it("never reports landed on status: completed without a usable transactionHash", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub([], [[202, { executionId: "exec_x", status: "completed" }]]),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).not.toBe("landed");
      expect(outcome.status).toBe("unresolved");
    });

    it("reports unresolved, never refused, on status: unconfirmed -- the transaction may still land, and a caller that treats this as a refusal risks double-broadcasting", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub(
            [],
            [[202, { executionId: "exec_456", status: "unconfirmed", transactionHash: "0xunconfirmed" }]],
          ),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).not.toBe("refused");
      expect(outcome.status).toBe("unresolved");
      if (outcome.status === "unresolved") {
        expect(outcome.transactionHash).toBe("0xunconfirmed");
        expect(outcome.executionId).toBe("exec_456");
      }
    });

    it("reports unresolved, never refused, on status: unconfirmed even with no transactionHash yet", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub([], [[202, { executionId: "exec_789", status: "unconfirmed" }]]),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).not.toBe("refused");
      expect(outcome.status).toBe("unresolved");
      if (outcome.status === "unresolved") expect(outcome.transactionHash).toBeUndefined();
    });

    it("reports unresolved (not refused) on status: failed when a transactionHash is present -- a hash means a transaction reached the chain", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub(
            [],
            [
              [
                202,
                {
                  executionId: "exec_abc",
                  status: "failed",
                  transactionHash: "0xfailedhash",
                  error: "confirmation timed out",
                },
              ],
            ],
          ),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).toBe("unresolved");
      if (outcome.status === "unresolved") {
        expect(outcome.transactionHash).toBe("0xfailedhash");
        expect(outcome.executionId).toBe("exec_abc");
        expect(outcome.detail).toContain("0xfailedhash");
      }
    });

    it("refuses on status: failed with no transactionHash, folding error into the detail", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub(
            [],
            [
              [
                202,
                {
                  executionId: "exec_def",
                  status: "failed",
                  error: "insufficient allowance",
                  rejection: "CFA_ACL_NO_SENDER_CREATE_PERMISSIONS",
                },
              ],
            ],
          ),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).toBe("refused");
      if (outcome.status === "refused") {
        expect(outcome.contract).toBe("status");
        expect(outcome.executionId).toBe("exec_def");
        expect(outcome.detail).toContain("insufficient allowance");
      }
    });

    it("never puts the API key or RPC URL in a new-shape (status: failed) refused outcome", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          rpcUrl: "https://eth-sepolia.g.alchemy.com/v2/sk-fake-should-not-leak",
          fetch: stub(
            [],
            [
              [
                202,
                {
                  executionId: "exec_leak",
                  status: "failed",
                  error: "boom kh_test leaked, also https://eth-sepolia.g.alchemy.com/v2/sk-fake-should-not-leak",
                },
              ],
            ],
          ),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).toBe("refused");
      expect(JSON.stringify(outcome)).not.toContain("kh_test");
      expect(JSON.stringify(outcome)).not.toContain("sk-fake-should-not-leak");
    });

    it("never reports landed on an unrecognised status value", async () => {
      const outcome = await executeAdjustment(
        baseDeps({
          fetch: stub([], [[202, { executionId: "exec_weird", status: "pending" }]]),
        }),
        policy(),
        adjustment(),
        NOW,
      );
      expect(outcome.status).not.toBe("landed");
      expect(outcome.status).toBe("unresolved");
    });
  });

  it("tags no contract field on old-shape (success-based) outcomes -- the compatibility guarantee keeps their shape byte-identical", async () => {
    const outcome = await executeAdjustment(
      baseDeps({ fetch: stub([], [[200, LANDED_BODY]]) }),
      policy(),
      adjustment(),
      NOW,
    );
    expect(outcome.status).toBe("landed");
    expect("contract" in outcome).toBe(false);
    expect("executionId" in outcome).toBe(false);
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
      // New contract's failure shape (status: "failed", no hash): extended
      // here per the controller's instruction to cover the new paths with
      // this same planted-secret check, not just the old-shape ones above.
      executeAdjustment(
        baseDeps({
          fetch: stub(
            [],
            [[202, { executionId: "exec_planted", status: "failed", error: "boom kh_test leaked" }]],
          ),
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
