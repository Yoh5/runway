import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import type { RunRecord } from "../../src/runner/record.js";
import { policyDigest, verifyRecord } from "../../src/runner/verify.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;
const STRANGER = "0x4444444444444444444444444444444444444444" as Address;

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
      { address: DISC, label: "disc", tier: "discretionary", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 10n },
    ],
    escalation: { webhook: "https://hooks.runway-ops.dev/escalations" },
    ...over,
  };
}

function facts(balance: bigint): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: balance,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: 100n },
      { receiver: STD, flowRateWeiPerSec: 100n },
      { receiver: DISC, flowRateWeiPerSec: 100n },
    ],
    unlistedOutflowWeiPerSec: 0n,
  };
}

/** A faithful record: the decision is what the policy produces from those facts. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  const f = facts(15_000n);
  const d = decide(f, policy());
  return {
    startedAt: "2026-09-10T12:00:00.000Z",
    nowSec: f.nowSec,
    facts: f,
    decision: d,
    outcomes: d.adjustments.map((adjustment) => ({
      adjustment,
      outcome: {
        status: "landed" as const,
        transactionHash: "0xabc",
        transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
      },
    })),
    escalations: [],
    ...over,
  };
}

describe("verifyRecord -- the decision follows from the facts", () => {
  it("passes a record whose decision is what the policy produces", () => {
    const verdict = verifyRecord(record(), policy());
    expect(verdict.ok).toBe(true);
  });

  it("fails a record whose decision kind does not follow from its own facts", () => {
    const tampered = record();
    const decision = tampered.decision as NonNullable<RunRecord["decision"]>;
    const verdict = verifyRecord({ ...tampered, decision: { ...decision, kind: "hold" } }, policy());
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/hold/);
  });

  it("fails a record whose adjustments were not the ones the policy would emit", () => {
    const tampered = record();
    const decision = tampered.decision as NonNullable<RunRecord["decision"]>;
    const [first] = decision.adjustments;
    if (!first) throw new Error("fixture must produce at least one adjustment");
    const verdict = verifyRecord(
      {
        ...tampered,
        decision: {
          ...decision,
          adjustments: [{ ...first, toRateWeiPerSec: first.toRateWeiPerSec - 1n }],
        },
      },
      policy(),
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("verifyRecord -- every write maps to the decision", () => {
  it("fails when a write was executed for a receiver the decision never named", () => {
    const base = record();
    const decision = base.decision as NonNullable<RunRecord["decision"]>;
    const [first] = decision.adjustments;
    if (!first) throw new Error("fixture must produce at least one adjustment");
    const verdict = verifyRecord(
      {
        ...base,
        outcomes: [
          ...base.outcomes,
          {
            adjustment: { ...first, receiver: STRANGER },
            outcome: {
              status: "landed",
              transactionHash: "0xdead",
              transactionLink: "https://sepolia.etherscan.io/tx/0xdead",
            },
          },
        ],
      },
      policy(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/unmapped|not in the decision/i);
  });

  it("passes when a decided adjustment was never executed, since refusing to write is allowed", () => {
    const base = record();
    const verdict = verifyRecord({ ...base, outcomes: [] }, policy());
    expect(verdict.ok).toBe(true);
  });
});

describe("verifyRecord -- what cannot be checked", () => {
  it("reports a run that never read the chain as unverifiable, not as a failure", () => {
    const verdict = verifyRecord(
      {
        ...record(),
        facts: null,
        decision: null,
        outcomes: [],
        escalations: [{ kind: "read-incomplete", detail: "rpc timed out", delivered: true }],
      },
      policy(),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toMatch(/no facts|read/i);
  });

  it("fails a record that carries facts but no decision, which cannot happen honestly", () => {
    const verdict = verifyRecord({ ...record(), decision: null }, policy());
    expect(verdict.ok).toBe(false);
  });

  it("says so when the policy digest recorded is not the policy it is checked against", () => {
    const verdict = verifyRecord({ ...record(), policyDigest: "sha256:not-this-one" }, policy());
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/digest|policy/i);
  });
});

describe("verifyRecord -- what the record does not claim", () => {
  it("says a passing record was checked against an assumed policy when it carries no digest", () => {
    const verdict = verifyRecord(record(), policy());
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toMatch(/no policy digest|assumed/i);
  });

  it("stays quiet about the digest when the record carries a matching one", () => {
    const verdict = verifyRecord({ ...record(), policyDigest: policyDigest(policy()) }, policy());
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).not.toMatch(/assumed/i);
  });
});
