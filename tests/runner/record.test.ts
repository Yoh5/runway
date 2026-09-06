import { describe, expect, it } from "vitest";
import { fromSerialisable, toSerialisable } from "../../src/runner/record.js";
import type { RunRecord } from "../../src/runner/record.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import { decide } from "../../src/policy/decide.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

function policy(): Policy {
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
  };
}

function facts(balance: bigint, rates: [bigint, bigint, bigint]): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: balance,
    depositWei: 400n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: rates[0] },
      { receiver: STD, flowRateWeiPerSec: rates[1] },
      { receiver: DISC, flowRateWeiPerSec: rates[2] },
    ],
    unlistedOutflowWeiPerSec: 25n,
  };
}

/** Round-trips a record through the exact path a file on disk goes through. */
function roundTrip(record: RunRecord): RunRecord {
  const json = JSON.stringify(toSerialisable(record));
  return fromSerialisable(JSON.parse(json));
}

describe("fromSerialisable", () => {
  it("round-trips a full record (facts, decision, outcomes, escalations) with every bigint restored", () => {
    const f = facts(15_000n, [100n, 100n, 100n]);
    const record: RunRecord = {
      startedAt: "2026-09-10T12:00:00.000Z",
      nowSec: 1_700_000_000,
      facts: f,
      decision: decide(f, policy()),
      outcomes: [
        {
          adjustment: { receiver: DISC, fromRateWeiPerSec: 100n, toRateWeiPerSec: 0n, reason: "budget-shed" },
          outcome: {
            status: "landed",
            transactionHash: "0xabc",
            transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
            gasUsedWei: "21000",
            effectiveGasPriceWei: "1000000000",
            sponsored: false,
          },
        },
      ],
      escalations: [{ kind: "floors-exceed-budget", detail: "20 wei/sec above budget", delivered: true }],
    };

    const revived = roundTrip(record);
    expect(revived).toEqual(record);
    // Prove these are real bigints, not strings that happen to compare equal.
    expect(typeof revived.facts?.availableBalanceWei).toBe("bigint");
    expect(typeof revived.decision?.runwaySec).toBe("bigint");
    expect(typeof revived.decision?.adjustments[0]?.toRateWeiPerSec).toBe("bigint");
  });

  it("round-trips a read-incomplete record with null facts and null decision", () => {
    const record: RunRecord = {
      startedAt: "2026-09-10T12:00:00.000Z",
      nowSec: 1_700_000_000,
      facts: null,
      decision: null,
      outcomes: [],
      escalations: [{ kind: "read-incomplete", detail: "RPC timeout", delivered: false }],
    };
    expect(roundTrip(record)).toEqual(record);
  });

  it("round-trips a null runwaySec (no net outflow to divide by)", () => {
    const f = { ...facts(30_000n, [0n, 0n, 0n]), unlistedOutflowWeiPerSec: 0n };
    const record: RunRecord = {
      startedAt: "2026-09-10T12:00:00.000Z",
      nowSec: 1_700_000_000,
      facts: f,
      decision: decide(f, policy()),
      outcomes: [],
      escalations: [],
    };
    const revived = roundTrip(record);
    expect(revived.decision?.runwaySec).toBeNull();
    expect(revived).toEqual(record);
  });
});
