import { describe, expect, it } from "vitest";
import { planRestore, RestorePlanError, type RestoreInputs } from "../../scripts/lib/plan-restore.js";
import type { Address, Policy } from "../../src/policy/types.js";

const CRITICAL = "0x000000000000000000000000000000000000dead" as Address;
const STANDARD = "0x00000000000000000000000000000000deaddead" as Address;
const DISCRETIONARY = "0x0000000000000000000000000000deaddeaddead" as Address;

/** The live Sepolia policy, typed out so this suite touches no filesystem. */
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
    escalation: { webhook: "https://hooks.runway-ops.dev/escalations" },
    ...over,
  };
}

/** The state the chain is actually in today: every stream sitting on its floor. */
function floorRates(policy: Policy): bigint[] {
  return policy.recipients.map((r) => r.floorRateWeiPerSec);
}

function inputs(over: Partial<RestoreInputs> = {}): RestoreInputs {
  const policy = over.policy ?? realPolicy();
  return {
    policy,
    currentAvailableBalanceWei: 24_431_708_160_423_600n, // the balance of the 8 September run
    currentStreamRatesWeiPerSec: floorRates(policy),
    unlistedOutflowWeiPerSec: 0n,
    nowSec: 1_700_000_000,
    marginSec: 0n,
    ...over,
  };
}

describe("planRestore -- the balance a restore needs", () => {
  it("prices the threshold at the committed rates, not at today's degraded ones", () => {
    const policy = realPolicy();
    const plan = planRestore(inputs({ policy }));

    const committed = policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n);
    expect(plan.committedOutflowWeiPerSec).toBe(committed);
    expect(plan.restoreThresholdWei).toBe(committed * (policy.targetRunwaySec + policy.hysteresisSec));
  });

  it("asks for the shortfall between the live balance and that threshold", () => {
    const plan = planRestore(inputs());
    expect(plan.wrapAmountWei).toBe(plan.restoreThresholdWei - 24_431_708_160_423_600n);
    expect(plan.wrapAmountWei).toBeGreaterThan(0n);
  });

  it("asks for nothing when the treasury is already above the band", () => {
    const policy = realPolicy();
    const committed = policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n);
    const plan = planRestore(
      inputs({
        policy,
        currentAvailableBalanceWei: committed * (policy.targetRunwaySec + policy.hysteresisSec) + 1n,
      }),
    );
    expect(plan.wrapAmountWei).toBe(0n);
    expect(plan.alreadyRestorable).toBe(true);
  });

  it("adds the margin, because the balance keeps draining while the wrap confirms", () => {
    const bare = planRestore(inputs());
    const withMargin = planRestore(inputs({ marginSec: 2n * 3600n }));

    expect(withMargin.wrapAmountWei - bare.wrapAmountWei).toBe(
      bare.committedOutflowWeiPerSec * 2n * 3600n,
    );
  });
});

describe("planRestore -- what the next tick would then decide", () => {
  it("decides restore, and walks every stream back to its committed rate", () => {
    const policy = realPolicy();
    const plan = planRestore(inputs({ policy, marginSec: 3600n }));

    expect(plan.resultingDecision.kind).toBe("restore");
    expect(plan.resultingDecision.adjustments).toHaveLength(3);
    for (const adjustment of plan.resultingDecision.adjustments) {
      const recipient = policy.recipients.find((r) => r.address === adjustment.receiver);
      expect(adjustment.toRateWeiPerSec).toBe(recipient?.committedRateWeiPerSec);
      expect(adjustment.reason).toBe("restore-to-committed");
    }
  });

  it("restores the most critical first, which is the shed order reversed", () => {
    const plan = planRestore(inputs({ marginSec: 3600n }));
    expect(plan.resultingDecision.adjustments.map((a) => a.receiver)).toEqual([
      CRITICAL,
      STANDARD,
      DISCRETIONARY,
    ]);
  });

  it("still holds when the wrap lands exactly one wei short of the band", () => {
    const policy = realPolicy();
    const committed = policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n);
    const plan = planRestore(
      inputs({
        policy,
        currentAvailableBalanceWei:
          committed * (policy.targetRunwaySec + policy.hysteresisSec) - committed,
      }),
    );
    // The plan asks for exactly the shortfall, so the decision it reports is
    // the one that shortfall produces -- a restore, not a hold.
    expect(plan.resultingDecision.kind).toBe("restore");
  });

  it("reports the escalation when a stream was closed and cannot be reopened", () => {
    const policy = realPolicy();
    const rates = floorRates(policy);
    rates[2] = 0n; // discretionary closed: reopening would need createFlow
    const plan = planRestore(inputs({ policy, currentStreamRatesWeiPerSec: rates, marginSec: 3600n }));

    expect(plan.resultingDecision.escalation?.kind).toBe("stream-closed-cannot-restore");
    expect(plan.resultingDecision.adjustments).toHaveLength(2);
  });
});

describe("planRestore -- refusals", () => {
  it("refuses rates given in a different shape than the policy's recipients", () => {
    expect(() => planRestore(inputs({ currentStreamRatesWeiPerSec: [1n] }))).toThrow(
      RestorePlanError,
    );
  });

  it("refuses a negative margin", () => {
    expect(() => planRestore(inputs({ marginSec: -1n }))).toThrow(RestorePlanError);
  });
});

describe("planRestore -- a treasury that is already insolvent", () => {
  it("prices in the hole: the wrap must refill the deficit before anything counts toward the band", () => {
    const policy = realPolicy();
    const bare = planRestore(inputs({ policy, currentAvailableBalanceWei: 0n }));
    const inHole = planRestore(
      inputs({ policy, currentAvailableBalanceWei: -139_915_676_815_871_482n }),
    );

    expect(inHole.wrapAmountWei - bare.wrapAmountWei).toBe(139_915_676_815_871_482n);
  });

  it("reports the deficit rather than leaving a reader to infer it from a negative balance", () => {
    const plan = planRestore(inputs({ currentAvailableBalanceWei: -139_915_676_815_871_482n }));
    expect(plan.deficitWei).toBe(139_915_676_815_871_482n);
    expect(plan.alreadyRestorable).toBe(false);
  });

  it("reports no deficit for a solvent treasury", () => {
    expect(planRestore(inputs({ currentAvailableBalanceWei: 1n })).deficitWei).toBe(0n);
  });

  it("still lands on a balance that decides restore", () => {
    const plan = planRestore(
      inputs({ currentAvailableBalanceWei: -139_915_676_815_871_482n, marginSec: 3600n }),
    );
    expect(plan.resultingBalanceWei).toBeGreaterThan(plan.restoreThresholdWei);
    expect(plan.resultingDecision.kind).toBe("restore");
  });
});
