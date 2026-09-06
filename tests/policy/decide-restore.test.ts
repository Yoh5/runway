import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

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

describe("decide — restore", () => {
  it("holds while the balance sits inside the hysteresis band", () => {
    // Committed outflow 300/sec. target + hysteresis = 250s -> needs 75000.
    // 60000 clears the 100s minimum at the degraded rate but not the band.
    const d = decide(facts(60_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.adjustments).toEqual([]);
  });

  it("restores toward committed rates once above the band", () => {
    const d = decide(facts(75_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("restore");
    expect(d.breach).toBe(false);
    expect(d.adjustments).toHaveLength(1);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(100n);
    expect(d.adjustments[0]?.reason).toBe("restore-to-committed");
  });

  it("restores critical before discretionary", () => {
    const d = decide(facts(75_000n, [0n, 0n, 0n]), policy());
    expect(d.adjustments.map((a) => a.receiver)).toEqual([CRIT, STD, DISC]);
  });

  it("holds when every stream already runs at its committed rate", () => {
    const d = decide(facts(75_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.adjustments).toEqual([]);
  });

  it("never restores above the committed rate", () => {
    const overpaying = facts(75_000n, [150n, 100n, 100n]), p = policy();
    const d = decide(overpaying, p);
    for (const a of d.adjustments) {
      const committed = p.recipients.find((r) => r.address === a.receiver)?.committedRateWeiPerSec;
      expect(a.toRateWeiPerSec).toBeLessThanOrEqual(committed ?? 0n);
    }
  });
});
