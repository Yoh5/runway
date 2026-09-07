import { decide } from "../../src/policy/decide.js";
import type { Address, Decision, Facts, Policy, Tier } from "../../src/policy/types.js";

/**
 * Pure arithmetic for sizing the demo breach: how far the treasury's ETHx
 * balance must fall (via `downgradeToETH`) before `decide()` reports a
 * breach, and, further, before that breach's shed cannot be absorbed by the
 * three floors alone. No network, no filesystem, no clock beyond the
 * `nowSec` the caller supplies for `Facts` -- exactly the shape
 * `scripts/lib/plan.ts` already uses, so this is unit-testable with no
 * chain.
 *
 * `decide()` itself (already tested in tests/policy/) is the source of
 * truth for what a given balance actually produces: this module derives the
 * two threshold balances algebraically, then hands the resulting balance to
 * the real `decide()` rather than re-deriving the shed loop -- so "which
 * tiers get touched" and "does it escalate" can never drift from what a live
 * run would actually do.
 */

export type BreachInputs = {
  /** The policy `decide()` will be run against -- thresholds and recipients. */
  policy: Policy;
  /** The treasury's live ETHx `availableBalance`, from `realtimeBalanceOf`. */
  currentAvailableBalanceWei: bigint;
  /** Each recipient's live flow rate, read via `getFlowInfo`, same order as `policy.recipients`. */
  currentStreamRatesWeiPerSec: readonly bigint[];
  /** Net outflow to receivers the policy does not list, read live via `getAccountFlowrate`. */
  unlistedOutflowWeiPerSec: bigint;
  /** Passed straight through to the `Facts` built for `decide()`. */
  nowSec: number;
  /**
   * The runway, in seconds, the unwrap should land the treasury at. A
   * parameter rather than a constant: which target is picked determines
   * whether the resulting shed escalates, and the brief is explicit that
   * this choice must stay visible at the call site, not be baked in here.
   * Must be strictly below `policy.minRunwaySec`, or the result would not
   * breach at all.
   */
  targetRunwaySecAfterUnwrap: bigint;
};

export type StreamBreachStatus = {
  address: Address;
  label: string;
  tier: Tier;
  currentRateWeiPerSec: bigint;
  floorRateWeiPerSec: bigint;
  /** Whether the resulting decision includes an adjustment for this receiver. */
  touchedByShed: boolean;
  /** Whether that adjustment brings the stream down to exactly its floor. */
  atFloor: boolean;
};

export type BreachPlan = {
  policy: Policy;
  /** Sum of the live stream rates plus unlisted outflow -- what `decide()` actually divides the balance by. */
  netOutflowWeiPerSec: bigint;
  /** `currentAvailableBalanceWei / netOutflowWeiPerSec`, floor division, exactly as `decide()` computes it. */
  currentRunwaySec: bigint;
  /** The balance below which `decide()` stops holding: `netOutflowWeiPerSec * policy.minRunwaySec`. */
  breachThresholdWei: bigint;
  /**
   * The balance below which the three floors, even all reached, cannot
   * absorb the shed the budget demands: `sum(floorRateWeiPerSec) *
   * policy.targetRunwaySec`.
   */
  escalationBoundaryWei: bigint;
  /** The balance `targetRunwaySecAfterUnwrap` requires: `netOutflowWeiPerSec * targetRunwaySecAfterUnwrap`. */
  requiredBalanceWei: bigint;
  /** `currentAvailableBalanceWei - requiredBalanceWei` -- the amount to pass to `downgradeToETH`. */
  unwrapAmountWei: bigint;
  /** What `decide()` actually returns when run against the post-unwrap balance. */
  resultingDecision: Decision;
  streamStatuses: readonly StreamBreachStatus[];
};

export class BreachPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BreachPlanError";
  }
}

export function planBreach(inputs: BreachInputs): BreachPlan {
  const { policy } = inputs;

  if (inputs.currentStreamRatesWeiPerSec.length !== policy.recipients.length) {
    throw new BreachPlanError(
      `currentStreamRatesWeiPerSec has ${inputs.currentStreamRatesWeiPerSec.length} entries but policy.recipients has ${policy.recipients.length} -- they must be given in the same order`,
    );
  }

  const netOutflowWeiPerSec =
    inputs.currentStreamRatesWeiPerSec.reduce((sum, rate) => sum + rate, 0n) +
    inputs.unlistedOutflowWeiPerSec;
  if (netOutflowWeiPerSec <= 0n) {
    throw new BreachPlanError(
      `net outflow (${netOutflowWeiPerSec} wei/sec) is zero or negative -- there is no runway to shorten`,
    );
  }

  const currentRunwaySec = inputs.currentAvailableBalanceWei / netOutflowWeiPerSec;

  // decide(): breach iff floor(bal/netOutflow) < minRunwaySec, which holds
  // exactly iff bal < netOutflow*minRunwaySec (floor(bal/n) < m  <=>  bal <
  // n*m for positive integers n, m).
  const breachThresholdWei = netOutflowWeiPerSec * policy.minRunwaySec;

  // decide(): escalation ("floors-exceed-budget") iff, after every floor is
  // reached, need = netOutflow - floor(bal/targetRunwaySec) still exceeds
  // totalReducible = netOutflow - sumFloors. That reduces to floor(bal /
  // targetRunwaySec) < sumFloors, i.e. bal < targetRunwaySec * sumFloors --
  // same exact floor-division identity as the breach threshold above.
  const sumFloorsWeiPerSec = policy.recipients.reduce(
    (sum, r) => sum + r.floorRateWeiPerSec,
    0n,
  );
  const escalationBoundaryWei = sumFloorsWeiPerSec * policy.targetRunwaySec;

  if (inputs.targetRunwaySecAfterUnwrap >= policy.minRunwaySec) {
    throw new BreachPlanError(
      `targetRunwaySecAfterUnwrap (${inputs.targetRunwaySecAfterUnwrap}s) does not clear minRunwaySec (${policy.minRunwaySec}s) -- landing there would not breach at all`,
    );
  }

  const requiredBalanceWei = netOutflowWeiPerSec * inputs.targetRunwaySecAfterUnwrap;

  const unwrapAmountWei = inputs.currentAvailableBalanceWei - requiredBalanceWei;
  if (unwrapAmountWei <= 0n) {
    throw new BreachPlanError(
      `current balance (${inputs.currentAvailableBalanceWei} wei) is already at or below the balance the target runway requires (${requiredBalanceWei} wei) -- nothing to unwrap`,
    );
  }

  const facts: Facts = {
    nowSec: inputs.nowSec,
    availableBalanceWei: requiredBalanceWei,
    depositWei: 0n,
    streams: policy.recipients.map((r, i) => ({
      receiver: r.address,
      flowRateWeiPerSec: inputs.currentStreamRatesWeiPerSec[i] as bigint,
    })),
    unlistedOutflowWeiPerSec: inputs.unlistedOutflowWeiPerSec,
  };
  const resultingDecision = decide(facts, policy);

  const adjustmentByReceiver = new Map(
    resultingDecision.adjustments.map((a) => [a.receiver, a] as const),
  );
  const streamStatuses: StreamBreachStatus[] = policy.recipients.map((r, i) => {
    const adjustment = adjustmentByReceiver.get(r.address);
    return {
      address: r.address,
      label: r.label,
      tier: r.tier,
      currentRateWeiPerSec: inputs.currentStreamRatesWeiPerSec[i] as bigint,
      floorRateWeiPerSec: r.floorRateWeiPerSec,
      touchedByShed: adjustment !== undefined,
      atFloor: adjustment !== undefined && adjustment.toRateWeiPerSec === r.floorRateWeiPerSec,
    };
  });

  return {
    policy,
    netOutflowWeiPerSec,
    currentRunwaySec,
    breachThresholdWei,
    escalationBoundaryWei,
    requiredBalanceWei,
    unwrapAmountWei,
    resultingDecision,
    streamStatuses,
  };
}
