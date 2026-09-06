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

describe("decide — restore weighs unlisted outflow", () => {
  it("holds back a restore that committed-only rates would have cleared", () => {
    // Current rates sit at their floors (80/50/0 = 130/sec listed), so the
    // top-level runway check passes easily: netOutflow = 130 + 100 = 230,
    // runway = 90000/230 = 391s, well above the 100s minimum.
    //
    // Committed outflow is 300/sec (100 each). Committed-only runway would be
    // 90000/300 = 300s, clearing the 250s band (target 200 + hysteresis 50)
    // and restoring. But total committed drain, unlisted included, is
    // 300 + 100 = 400/sec: 90000/400 = 225s, which does NOT clear 250s. The
    // fix must hold here.
    const f = { ...facts(90_000n, [80n, 50n, 0n]), unlistedOutflowWeiPerSec: 100n };
    const d = decide(f, policy());
    expect(d.kind).toBe("hold");
    expect(d.adjustments).toEqual([]);
  });

  it("still restores when the unlisted drain is small enough to clear the band", () => {
    // Same shape as above, but unlisted outflow is only 50/sec. Committed
    // total = 300 + 50 = 350/sec: 90000/350 = 257s (350*257=89950), which
    // clears the 250s band, so restoration proceeds for CRIT and STD.
    // DISC sits at rate 0 -- closed, per the controller's ruling a rate-zero
    // stream cannot be reopened by Runway -- so it raises the escalation
    // instead of a 0 -> 100 adjustment.
    const f = { ...facts(90_000n, [80n, 50n, 0n]), unlistedOutflowWeiPerSec: 50n };
    const d = decide(f, policy());
    expect(d.kind).toBe("restore");
    expect(d.adjustments).toHaveLength(2);
    for (const a of d.adjustments) {
      expect(a.toRateWeiPerSec).toBe(100n);
      expect(a.reason).toBe("restore-to-committed");
    }
    expect(d.adjustments.map((a) => a.receiver)).toEqual([CRIT, STD]);
    expect(d.escalation?.kind).toBe("stream-closed-cannot-restore");
    expect(d.escalation?.detail).toContain(DISC);
  });

  it("evaluates on the merits, not the old zero-committed-outflow guard", () => {
    // All committed rates are 0, so committedOutflow (listed only) is 0 — the
    // old guard would return hold immediately regardless of anything else.
    // But unlisted outflow is 100/sec, so committed total is 100/sec, a
    // non-zero divisor the fixed guard must not skip.
    //
    // Current rates (50/30/20 = 100/sec listed) plus 100 unlisted = 200/sec
    // net outflow: runway = 25000/200 = 125s, above the 100s minimum, so the
    // top-level check reaches considerRestore.
    //
    // Committed total = 0 + 100 = 100/sec: 25000/100 = 250s, which exactly
    // clears the 250s band (target 200 + hysteresis 50), so restoration
    // proceeds — every stream is set down to its committed rate of 0.
    const zeroCommittedPolicy = policy({
      recipients: [
        { address: CRIT, label: "crit", tier: "critical", committedRateWeiPerSec: 0n, floorRateWeiPerSec: 0n },
        { address: STD, label: "std", tier: "standard", committedRateWeiPerSec: 0n, floorRateWeiPerSec: 0n },
        { address: DISC, label: "disc", tier: "discretionary", committedRateWeiPerSec: 0n, floorRateWeiPerSec: 0n },
      ],
    });
    const f = { ...facts(25_000n, [50n, 30n, 20n]), unlistedOutflowWeiPerSec: 100n };
    const d = decide(f, zeroCommittedPolicy);
    expect(d.kind).toBe("restore");
    expect(d.adjustments).toHaveLength(3);
    for (const a of d.adjustments) {
      expect(a.toRateWeiPerSec).toBe(0n);
    }
  });

  it("is unchanged from before when unlisted outflow is zero, modulo the closed-stream rule", () => {
    // Committed outflow 300/sec, committed total unchanged at 300/sec since
    // unlisted is 0. 75000/300 = 250s clears the band. CRIT and STD already
    // sit at their committed rate (nothing to do); DISC sits at rate 0 --
    // closed, so it raises the escalation rather than a 0 -> 100 adjustment.
    const f = { ...facts(75_000n, [100n, 100n, 0n]), unlistedOutflowWeiPerSec: 0n };
    const d = decide(f, policy());
    expect(d.kind).toBe("hold");
    expect(d.breach).toBe(false);
    expect(d.adjustments).toEqual([]);
    expect(d.escalation?.kind).toBe("stream-closed-cannot-restore");
    expect(d.escalation?.detail).toContain(DISC);
  });
});
