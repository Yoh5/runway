import { describe, expect, it } from "vitest";
import { runOnce } from "../../src/runner/run.js";
import type { RunDeps } from "../../src/runner/run.js";
import { toSerialisable } from "../../src/runner/record.js";
import { readFacts, ReadIncompleteError } from "../../src/chain/reader.js";
import type { PublicClientLike } from "../../src/chain/reader.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import type { ExecutionOutcome } from "../../src/keeperhub/execute.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

/** Matches the fixtures in tests/policy/decide-reduce.test.ts (Task 2's suite). */
function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [
      { address: CRIT, label: "crit", tier: "critical", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 80n },
      { address: STD, label: "std", tier: "standard", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 50n },
      { address: DISC, label: "disc", tier: "discretionary", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
    ...over,
  };
}

function facts(balance: bigint, rates: [bigint, bigint, bigint]): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: balance,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: rates[0] },
      { receiver: STD, flowRateWeiPerSec: rates[1] },
      { receiver: DISC, flowRateWeiPerSec: rates[2] },
    ],
    unlistedOutflowWeiPerSec: 0n,
  };
}

// facts(15_000n, [100n, 100n, 100n]) with the policy above yields a "reduce"
// decision whose floors together still exceed the budget (see
// tests/policy/decide-reduce.test.ts): three adjustments, and a
// "floors-exceed-budget" escalation.
const LANDED: ExecutionOutcome = {
  status: "landed",
  transactionHash: "0xabc",
  transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
  gasUsedWei: "1",
  effectiveGasPriceWei: "1000000000",
  sponsored: false,
};
const REFUSED: ExecutionOutcome = { status: "refused", stage: "broadcast", detail: "CFA: ACL denied" };
const UNRESOLVED_WITH_HASH: ExecutionOutcome = {
  status: "unresolved",
  transactionHash: "0xdeadbeef",
  detail: "broadcast reported success: false but transactionHash 0xdeadbeef is present",
};
const UNRESOLVED_NO_HASH: ExecutionOutcome = {
  status: "unresolved",
  detail: "broadcast request failed: socket hang up",
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    readFacts: async () => facts(15_000n, [100n, 100n, 100n]),
    execute: async () => LANDED,
    notify: async () => {},
    ...over,
  };
}

describe("runOnce", () => {
  it("records the facts, the decision and one outcome per adjustment", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(record.decision?.kind).toBe("reduce");
    expect(record.facts).not.toBeNull();
    expect(record.outcomes).toHaveLength(record.decision?.adjustments.length ?? -1);
  });

  it("executes nothing on a hold decision", async () => {
    let executed = 0;
    const record = await runOnce(
      deps({
        readFacts: async () => facts(30_000n, [100n, 100n, 100n]),
        execute: async () => {
          executed += 1;
          return LANDED;
        },
      }),
      policy(),
      1_700_000_000,
    );
    expect(record.decision?.kind).toBe("hold");
    expect(executed).toBe(0);
    expect(record.outcomes).toHaveLength(0);
  });

  it("takes no decision and executes nothing when the read fails", async () => {
    let executed = 0;
    const record = await runOnce(
      deps({
        readFacts: async () => {
          throw new ReadIncompleteError([{ what: "getFlowInfo", reason: "timeout" }]);
        },
        execute: async () => {
          executed += 1;
          return LANDED;
        },
      }),
      policy(),
      1_700_000_000,
    );
    expect(record.facts).toBeNull();
    expect(record.decision).toBeNull();
    expect(executed).toBe(0);
    expect(record.escalations.map((e) => e.kind)).toContain("read-incomplete");
  });

  it("still executes the cuts when the decision carries an escalation", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).toContain("floors-exceed-budget");
    expect(record.outcomes.length).toBeGreaterThan(0);
  });

  it("continues to the remaining adjustments after one is refused", async () => {
    let call = 0;
    const record = await runOnce(
      deps({ execute: async () => (call++ === 0 ? REFUSED : LANDED) }),
      policy(),
      1_700_000_000,
    );
    expect(record.outcomes).toHaveLength(record.decision?.adjustments.length ?? -1);
    expect(record.outcomes.some((o) => o.outcome.status === "landed")).toBe(true);
    expect(record.outcomes.some((o) => o.outcome.status === "refused")).toBe(true);
  });

  it("raises a run-level escalation when a write is refused", async () => {
    const record = await runOnce(deps({ execute: async () => REFUSED }), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).toContain("mandate-rejected");
  });

  it("raises a write-outcome-unknown escalation carrying the hash when an outcome is unresolved with a transaction hash", async () => {
    let call = 0;
    const record = await runOnce(
      deps({ execute: async () => (call++ === 0 ? UNRESOLVED_WITH_HASH : LANDED) }),
      policy(),
      1_700_000_000,
    );
    const matches = record.escalations.filter((e) => e.kind === "write-outcome-unknown");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.detail).toContain("0xdeadbeef");
  });

  it("raises no write-outcome-unknown escalation when an unresolved outcome carries no transaction hash", async () => {
    const record = await runOnce(deps({ execute: async () => UNRESOLVED_NO_HASH }), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).not.toContain("write-outcome-unknown");
  });

  it("still raises mandate-rejected for a refused outcome (no regression)", async () => {
    const record = await runOnce(deps({ execute: async () => REFUSED }), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).toContain("mandate-rejected");
  });

  it("raises both escalations when a run has a refusal and an unresolved-with-hash outcome", async () => {
    let call = 0;
    const record = await runOnce(
      deps({ execute: async () => (call++ === 0 ? REFUSED : UNRESOLVED_WITH_HASH) }),
      policy(),
      1_700_000_000,
    );
    expect(record.escalations.map((e) => e.kind)).toContain("mandate-rejected");
    expect(record.escalations.map((e) => e.kind)).toContain("write-outcome-unknown");
  });

  it("delivers the write-outcome-unknown escalation through the same path, recording delivery failure rather than swallowing it", async () => {
    const record = await runOnce(
      deps({
        execute: async () => UNRESOLVED_WITH_HASH,
        notify: async () => {
          throw new Error("webhook 500");
        },
      }),
      policy(),
      1_700_000_000,
    );
    const escalation = record.escalations.find((e) => e.kind === "write-outcome-unknown");
    expect(escalation).toBeDefined();
    expect(escalation?.delivered).toBe(false);
  });

  it("records a failed escalation rather than swallowing it", async () => {
    const record = await runOnce(
      deps({
        notify: async () => {
          throw new Error("webhook 500");
        },
      }),
      policy(),
      1_700_000_000,
    );
    expect(record.escalations.length).toBeGreaterThan(0);
    expect(record.escalations.every((e) => e.delivered === false)).toBe(true);
  });

  it("serialises every bigint as a decimal string", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(() => JSON.stringify(toSerialisable(record))).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(toSerialisable(record))) as { facts: { availableBalanceWei: string } };
    expect(roundTripped.facts.availableBalanceWei).toBe("15000");
  });

  it("only ever writes the documented run-record fields, never the raw dependencies", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(Object.keys(record).sort()).toEqual(
      ["decision", "escalations", "facts", "nowSec", "outcomes", "startedAt"].sort(),
    );
  });

  it("never lets a hosted RPC provider's key reach the serialised run record (I4)", async () => {
    // Exercises the real chain/reader.ts, not a stub: a hosted RPC provider
    // (Alchemy, Infura, ...) embeds its key in the URL path itself, which
    // survives into a thrown HttpRequestError's message untouched -- viem's
    // own credential stripping only handles basic-auth. That message must
    // never reach failures[].reason, the ReadIncompleteError message, the
    // run-level escalation's detail, or the serialised run record.
    const FAKE_PROVIDER_KEY = "sk-fake-alchemy-key-should-never-leak-9f3a";
    const rpcUrl = `https://eth-sepolia.g.alchemy.com/v2/${FAKE_PROVIDER_KEY}`;
    const client: PublicClientLike = {
      readContract: async () => {
        throw new Error(`HttpRequestError: fetch failed for ${rpcUrl} — 500 Internal Server Error`);
      },
    };

    const record = await runOnce(
      {
        readFacts: (p, n) => readFacts({ client, rpcUrl }, p, n),
        execute: async () => LANDED,
        notify: async () => {},
      },
      policy(),
      1_700_000_000,
    );

    expect(record.facts).toBeNull();
    expect(record.escalations.map((e) => e.kind)).toContain("read-incomplete");
    const serialised = JSON.stringify(toSerialisable(record));
    expect(serialised).not.toContain(FAKE_PROVIDER_KEY);
    // The escalation this run recorded must still describe the failure, just
    // with the key stripped out -- not silently emptied.
    expect(record.escalations[0]?.detail).toContain("[redacted]");
  });

  it("never lets a secret a collaborator closes over reach the run record", async () => {
    const secretApiKey = "kh_super_secret_should_never_appear";
    const record = await runOnce(
      deps({
        // A real executor closes over an API key the way ExecutorDeps does;
        // the runner never sees it and must never echo it into the record
        // even though the closure captured it.
        execute: async () => {
          const apiKeyInScope = secretApiKey;
          return apiKeyInScope.length > 0 ? REFUSED : LANDED;
        },
      }),
      policy(),
      1_700_000_000,
    );
    expect(JSON.stringify(toSerialisable(record))).not.toContain(secretApiKey);
  });
});
