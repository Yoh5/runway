import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

/**
 * Small round numbers so every expectation below can be derived by hand.
 * `over` exists because one case needs a different target runway: with a
 * 200s target no balance can both breach the 100s minimum and leave a shed
 * small enough for the discretionary tier to absorb alone.
 */
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

describe("decide — hold", () => {
  it("holds when runway is at or above the minimum", () => {
    // 300 wei/sec outflow, 30000 balance -> 100s runway, exactly the minimum.
    const d = decide(facts(30_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.breach).toBe(false);
    expect(d.adjustments).toEqual([]);
    expect(d.runwaySec).toBe(100n);
  });

  it("reports a null runway when nothing is flowing", () => {
    const d = decide(facts(30_000n, [0n, 0n, 0n]), policy());
    expect(d.runwaySec).toBeNull();
    expect(d.kind).toBe("hold");
  });
});

describe("decide — reduce", () => {
  it("sheds from the discretionary tier first", () => {
    // 300/sec, balance 15000 -> runway 50s, below the 100s minimum.
    // budget = 15000 / 200 = 75/sec. Need to shed 225/sec.
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("reduce");
    expect(d.breach).toBe(true);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(0n);
  });

  it("never sends a stream below its floor", () => {
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    const floors = new Map([[CRIT, 80n], [STD, 50n], [DISC, 0n]]);
    for (const a of d.adjustments) {
      expect(a.toRateWeiPerSec).toBeGreaterThanOrEqual(floors.get(a.receiver) ?? 0n);
    }
  });

  it("escalates when every floor together still exceeds the budget, and still applies the cuts", () => {
    // budget = 15000/200 = 75/sec, floors sum to 130/sec.
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    expect(d.escalation?.kind).toBe("floors-exceed-budget");
    expect(d.adjustments.length).toBeGreaterThan(0);
  });

  it("touches a higher tier only once every lower tier sits at its floor", () => {
    // A 200s target cannot produce this case: breaching the 100s minimum needs
    // balance < 30000, while a shed small enough for one tier needs >= 40000.
    // With a 120s target: runway = 29000/300 = 96s, under the minimum.
    // budget = 29000/120 = 241/sec, so the shed is 300 - 241 = 59/sec, which
    // the discretionary stream absorbs alone: 100 - 59 = 41.
    const d = decide(facts(29_000n, [100n, 100n, 100n]), policy({ targetRunwaySec: 120n }));
    expect(d.kind).toBe("reduce");
    expect(d.adjustments).toHaveLength(1);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(41n);
    expect(d.escalation).toBeNull();
  });

  it("emits nothing for a stream that is already where the shed would leave it", () => {
    // Discretionary already at 0, its floor. Outflow 200/sec on 15000 is a
    // 75s runway, under the minimum. budget = 15000/200 = 75/sec, so 125/sec
    // must go: standard down to its 50 floor, then critical takes 20 more and
    // stops at 80. Discretionary has nothing left to give and must produce no
    // adjustment at all — a write that changes nothing still costs gas.
    const d = decide(facts(15_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("reduce");
    expect(d.adjustments.map((a) => a.receiver)).toEqual([STD, CRIT]);
    expect(d.adjustments.map((a) => a.toRateWeiPerSec)).toEqual([50n, 80n]);
    expect(d.adjustments.every((a) => a.fromRateWeiPerSec !== a.toRateWeiPerSec)).toBe(true);
  });
});
