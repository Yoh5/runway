import { describe, expect, it } from "vitest";
import {
  BreachPlanError,
  type BreachInputs,
  planBreach,
} from "../../scripts/lib/plan-breach.js";
import type { Address, Policy } from "../../src/policy/types.js";

const CRITICAL = "0x000000000000000000000000000000000000dead" as Address;
const STANDARD = "0x00000000000000000000000000000000deaddead" as Address;
const DISCRETIONARY = "0x0000000000000000000000000000deaddeaddead" as Address;

/**
 * The real, live Sepolia policy this task runs against (see
 * policies/treasury.sepolia.yaml), typed out rather than parsed from YAML so
 * this suite has no filesystem dependency. Every rate below is copied
 * verbatim from that file.
 */
function realPolicy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x30a6933ca9230361972e413a15dc8114c952414e" as Address,
    sender: "0xc4faed0e400911e44fb75e63566bf8aaaf0f7776" as Address,
    minRunwaySec: 72n * 3600n,
    targetRunwaySec: 168n * 3600n,
    hysteresisSec: 24n * 3600n,
    recipients: [
      {
        address: CRITICAL,
        label: "Critical tier (demo sink)",
        tier: "critical",
        committedRateWeiPerSec: 144_651_913_324n,
        floorRateWeiPerSec: 86_791_147_994n,
      },
      {
        address: STANDARD,
        label: "Standard tier (demo sink)",
        tier: "standard",
        committedRateWeiPerSec: 86_791_147_994n,
        floorRateWeiPerSec: 21_697_786_998n,
      },
      {
        address: DISCRETIONARY,
        label: "Discretionary tier (demo sink)",
        tier: "discretionary",
        committedRateWeiPerSec: 57_860_765_330n,
        floorRateWeiPerSec: 11_572_153_066n,
      },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
    ...over,
  };
}

/** Every stream still running at exactly its committed rate -- the live state confirmed by the dry run (`kind: "hold"`). */
function committedRates(policy: Policy): bigint[] {
  return policy.recipients.map((r) => r.committedRateWeiPerSec);
}

function realInputs(over: Partial<BreachInputs> = {}): BreachInputs {
  const policy = realPolicy();
  return {
    policy,
    currentAvailableBalanceWei: 249_817_904_564_121_072n, // ~0.2498 ETHx, matching the live read at runwaySec 863514
    currentStreamRatesWeiPerSec: committedRates(policy),
    unlistedOutflowWeiPerSec: 0n,
    nowSec: 1_700_000_000,
    targetRunwaySecAfterUnwrap: 24n * 3600n,
    ...over,
  };
}

describe("planBreach -- thresholds derived from the real Sepolia policy", () => {
  it("computes the net outflow as the sum of the live stream rates", () => {
    const plan = planBreach(realInputs());
    expect(plan.netOutflowWeiPerSec).toBe(289_303_826_648n);
  });

  it("computes the breach threshold: the balance below which runway falls under minRunwaySec (72h)", () => {
    // netOutflow * minRunwaySec = 289303826648 * 259200
    const plan = planBreach(realInputs());
    expect(plan.breachThresholdWei).toBe(74_987_551_867_161_600n);
  });

  it("computes the escalation boundary: the balance below which the three floors cannot cover the shed", () => {
    // sum(floorRateWeiPerSec) * targetRunwaySec = 120061088058 * 604800
    const plan = planBreach(realInputs());
    expect(plan.escalationBoundaryWei).toBe(72_612_946_057_478_400n);
  });

  it("the escalation boundary sits below the breach threshold, narrower than 0.0024 ETHx apart", () => {
    const plan = planBreach(realInputs());
    expect(plan.escalationBoundaryWei).toBeLessThan(plan.breachThresholdWei);
    const windowWei = plan.breachThresholdWei - plan.escalationBoundaryWei;
    expect(windowWei).toBe(2_374_605_809_683_200n); // ~0.002375 ETHx
  });

  it("reports the current runway from the live balance and net outflow", () => {
    const plan = planBreach(realInputs());
    expect(plan.currentRunwaySec).toBe(249_817_904_564_121_072n / 289_303_826_648n);
    expect(plan.currentRunwaySec).toBe(863_514n);
  });
});

describe("planBreach -- the unwrap amount for a target that escalates (default demo target: 24h)", () => {
  it("computes the exact balance the target runway requires", () => {
    // netOutflow * targetRunwaySecAfterUnwrap = 289303826648 * 86400
    const plan = planBreach(realInputs());
    expect(plan.requiredBalanceWei).toBe(24_995_850_622_387_200n);
  });

  it("computes the unwrap amount as current balance minus the required balance", () => {
    const plan = planBreach(realInputs());
    expect(plan.unwrapAmountWei).toBe(249_817_904_564_121_072n - 24_995_850_622_387_200n);
    expect(plan.unwrapAmountWei).toBe(224_822_053_941_733_872n);
  });

  it("the required balance clears breach (below breachThresholdWei) and escalation (below escalationBoundaryWei)", () => {
    const plan = planBreach(realInputs());
    expect(plan.requiredBalanceWei).toBeLessThan(plan.breachThresholdWei);
    expect(plan.requiredBalanceWei).toBeLessThan(plan.escalationBoundaryWei);
  });

  it("the resulting decision is a breaching reduce with all three tiers shed to their floor", () => {
    const plan = planBreach(realInputs());
    expect(plan.resultingDecision.kind).toBe("reduce");
    expect(plan.resultingDecision.breach).toBe(true);
    expect(plan.resultingDecision.adjustments).toHaveLength(3);
    for (const adjustment of plan.resultingDecision.adjustments) {
      const recipient = plan.policy.recipients.find((r) => r.address === adjustment.receiver);
      expect(adjustment.toRateWeiPerSec).toBe(recipient?.floorRateWeiPerSec);
    }
  });

  it("the resulting decision escalates -- floors-exceed-budget, matching the design's refusal of a silent breach", () => {
    const plan = planBreach(realInputs());
    expect(plan.resultingDecision.escalation).not.toBeNull();
    expect(plan.resultingDecision.escalation?.kind).toBe("floors-exceed-budget");
  });

  it("every stream status reports touched and at its floor", () => {
    const plan = planBreach(realInputs());
    expect(plan.streamStatuses).toHaveLength(3);
    for (const status of plan.streamStatuses) {
      expect(status.touchedByShed).toBe(true);
      expect(status.atFloor).toBe(true);
    }
  });
});

describe("planBreach -- the window where floors cover the shed without escalating (69h vs 70h)", () => {
  it("69h lands inside the escalation boundary -- escalates", () => {
    const plan = planBreach(realInputs({ targetRunwaySecAfterUnwrap: 69n * 3600n }));
    expect(plan.requiredBalanceWei).toBeLessThan(plan.escalationBoundaryWei);
    expect(plan.resultingDecision.escalation).not.toBeNull();
  });

  it("70h lands outside the escalation boundary -- floors alone cover the shed, no escalation", () => {
    const plan = planBreach(realInputs({ targetRunwaySecAfterUnwrap: 70n * 3600n }));
    expect(plan.requiredBalanceWei).toBeGreaterThanOrEqual(plan.escalationBoundaryWei);
    expect(plan.resultingDecision.escalation).toBeNull();
    expect(plan.resultingDecision.kind).toBe("reduce");
    expect(plan.resultingDecision.breach).toBe(true);
  });
});

describe("planBreach -- errors", () => {
  it("refuses a target runway that does not clear minRunwaySec -- that would not breach at all", () => {
    expect(() => planBreach(realInputs({ targetRunwaySecAfterUnwrap: 72n * 3600n }))).toThrow(
      BreachPlanError,
    );
    expect(() => planBreach(realInputs({ targetRunwaySecAfterUnwrap: 100n * 3600n }))).toThrow(
      /does not clear minRunwaySec/,
    );
  });

  it("refuses when the current balance is already at or below the balance the target requires", () => {
    expect(() =>
      planBreach(
        realInputs({
          currentAvailableBalanceWei: 1_000_000_000_000n,
          targetRunwaySecAfterUnwrap: 24n * 3600n,
        }),
      ),
    ).toThrow(BreachPlanError);
    expect(() =>
      planBreach(
        realInputs({
          currentAvailableBalanceWei: 1_000_000_000_000n,
          targetRunwaySecAfterUnwrap: 24n * 3600n,
        }),
      ),
    ).toThrow(/nothing to unwrap/);
  });

  it("refuses a stream-rate array whose length does not match the policy's recipients", () => {
    expect(() =>
      planBreach(realInputs({ currentStreamRatesWeiPerSec: [1n, 2n] })),
    ).toThrow(BreachPlanError);
    expect(() =>
      planBreach(realInputs({ currentStreamRatesWeiPerSec: [1n, 2n] })),
    ).toThrow(/currentStreamRatesWeiPerSec/);
  });

  it("refuses a net outflow of zero -- there is no runway to shorten", () => {
    expect(() =>
      planBreach(realInputs({ currentStreamRatesWeiPerSec: [0n, 0n, 0n] })),
    ).toThrow(BreachPlanError);
    expect(() =>
      planBreach(realInputs({ currentStreamRatesWeiPerSec: [0n, 0n, 0n] })),
    ).toThrow(/net outflow/);
  });
});
