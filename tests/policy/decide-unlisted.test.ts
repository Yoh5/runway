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

describe("decide — unlisted outflow", () => {
  it("counts unlisted outflow against the runway", () => {
    // Listed 200/sec plus 100/sec unlisted is 300/sec against 15000: a 50s
    // runway, not the 75s the listed streams alone would suggest.
    const f = { ...facts(15_000n, [100n, 100n, 0n]), unlistedOutflowWeiPerSec: 100n };
    expect(decide(f, policy()).runwaySec).toBe(50n);
  });

  it("breaches on unlisted outflow alone", () => {
    // Nothing listed is flowing, but 300/sec is leaving anyway.
    const f = { ...facts(15_000n, [0n, 0n, 0n]), unlistedOutflowWeiPerSec: 300n };
    const d = decide(f, policy());
    expect(d.kind).toBe("reduce");
    expect(d.breach).toBe(true);
  });

  it("never emits an adjustment for an unlisted receiver", () => {
    const f = { ...facts(15_000n, [100n, 100n, 0n]), unlistedOutflowWeiPerSec: 100n };
    const known = new Set(policy().recipients.map((r) => r.address));
    for (const a of decide(f, policy()).adjustments) {
      expect(known.has(a.receiver)).toBe(true);
    }
  });

  it("escalates when the unlisted drain alone exceeds the budget", () => {
    // budget = 15000/200 = 75/sec, all of which the unlisted 300/sec consumes.
    // Every listed stream can go to its floor and it still will not be enough.
    const f = { ...facts(15_000n, [100n, 100n, 100n]), unlistedOutflowWeiPerSec: 300n };
    expect(decide(f, policy()).escalation?.kind).toBe("floors-exceed-budget");
  });

  it("still reports a null runway when nothing at all is flowing", () => {
    const f = { ...facts(15_000n, [0n, 0n, 0n]), unlistedOutflowWeiPerSec: 0n };
    expect(decide(f, policy()).runwaySec).toBeNull();
  });
});
