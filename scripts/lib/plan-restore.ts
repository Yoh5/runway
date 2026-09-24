import { decide } from "../../src/policy/decide.js";
import type { Decision, Facts, Policy } from "../../src/policy/types.js";

/**
 * Pure arithmetic for the other half of the story: how much ETH the treasury
 * must wrap before `decide()` stops holding and starts restoring.
 *
 * `restore` is implemented, property-tested and has never fired on chain.
 * That is stated plainly in the submission, and it stays true until a live
 * run proves otherwise — this module is what makes that run a decision
 * rather than a guess, the same way `plan-breach` sized the shed.
 *
 * As there, the thresholds are derived algebraically and the resulting
 * balance is then handed to the real `decide()`, so what this prints can
 * never drift from what a tick would actually do.
 */

export type RestoreInputs = {
  policy: Policy;
  /** The treasury's live ETHx `availableBalance`, from `realtimeBalanceOf`. */
  currentAvailableBalanceWei: bigint;
  /** Each recipient's live flow rate, same order as `policy.recipients`. */
  currentStreamRatesWeiPerSec: readonly bigint[];
  /** Net outflow to receivers the policy does not list. */
  unlistedOutflowWeiPerSec: bigint;
  nowSec: number;
  /**
   * Extra seconds of committed outflow to wrap beyond the bare threshold.
   * The balance drains every second, including while the wrap transaction
   * confirms and while the operator gets to the tick, so a wrap sized to the
   * exact boundary can land the treasury one wei below it and decide `hold`
   * — a demo that proves nothing. Seconds rather than a percentage because
   * the thing being bought is time.
   */
  marginSec: bigint;
};

export type RestorePlan = {
  policy: Policy;
  /** Sum of the committed rates plus unlisted outflow: what the band is measured against. */
  committedOutflowWeiPerSec: bigint;
  /** Sum of the live rates plus unlisted outflow: what the treasury pays today. */
  currentOutflowWeiPerSec: bigint;
  /** Runway at today's degraded rates. */
  currentRunwaySec: bigint;
  /** Runway the balance would buy at the committed rates — the number `decide()` compares to the band. */
  runwayAtCommittedSec: bigint;
  /** `committedOutflow * (targetRunwaySec + hysteresisSec)`: at or above this, `decide()` restores. */
  restoreThresholdWei: bigint;
  /** Whether the treasury is already above the band, so nothing needs wrapping. */
  alreadyRestorable: boolean;
  /**
   * How far below zero the available balance has gone, or zero when solvent.
   * A negative `availableBalance` means the account is already insolvent and
   * anyone may liquidate it, taking the locked deposit as the reward. The
   * chain reader clamps that to zero on purpose, so a negative runway cannot
   * read as plenty of time — but a wrap must refill the hole before a single
   * wei counts toward the band, so sizing one against the clamped number
   * would understate it by exactly this much.
   */
  deficitWei: bigint;
  /** What to pass to `upgradeByETH` / `upgrade`, margin included. Zero when already restorable. */
  wrapAmountWei: bigint;
  /** The balance the wrap lands on. */
  resultingBalanceWei: bigint;
  /** What `decide()` actually returns against that balance. */
  resultingDecision: Decision;
};

export class RestorePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestorePlanError";
  }
}

export function planRestore(inputs: RestoreInputs): RestorePlan {
  const { policy } = inputs;

  if (inputs.currentStreamRatesWeiPerSec.length !== policy.recipients.length) {
    throw new RestorePlanError(
      `currentStreamRatesWeiPerSec has ${inputs.currentStreamRatesWeiPerSec.length} entries but policy.recipients has ${policy.recipients.length} -- they must be given in the same order`,
    );
  }
  if (inputs.marginSec < 0n) {
    throw new RestorePlanError(`marginSec must not be negative, got ${inputs.marginSec}`);
  }

  const committedOutflowWeiPerSec =
    policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n) +
    inputs.unlistedOutflowWeiPerSec;
  const currentOutflowWeiPerSec =
    inputs.currentStreamRatesWeiPerSec.reduce((sum, rate) => sum + rate, 0n) +
    inputs.unlistedOutflowWeiPerSec;

  if (committedOutflowWeiPerSec === 0n) {
    throw new RestorePlanError(
      "committed outflow is zero: there is nothing to restore to, and decide() would hold whatever the balance",
    );
  }

  // The band `decide()` actually tests: runway at committed rates must reach
  // target + hysteresis. The hysteresis is what stops a treasury hovering on
  // the threshold from restoring and shedding on alternate ticks.
  const restoreThresholdWei =
    committedOutflowWeiPerSec * (policy.targetRunwaySec + policy.hysteresisSec);

  const deficitWei =
    inputs.currentAvailableBalanceWei < 0n ? -inputs.currentAvailableBalanceWei : 0n;
  const alreadyRestorable = inputs.currentAvailableBalanceWei >= restoreThresholdWei;
  const shortfallWei = alreadyRestorable
    ? 0n
    : restoreThresholdWei - inputs.currentAvailableBalanceWei;
  const wrapAmountWei = alreadyRestorable
    ? 0n
    : shortfallWei + committedOutflowWeiPerSec * inputs.marginSec;
  const resultingBalanceWei = inputs.currentAvailableBalanceWei + wrapAmountWei;

  const facts: Facts = {
    nowSec: inputs.nowSec,
    availableBalanceWei: resultingBalanceWei,
    depositWei: 0n,
    streams: policy.recipients.map((recipient, index) => ({
      receiver: recipient.address,
      flowRateWeiPerSec: inputs.currentStreamRatesWeiPerSec[index] ?? 0n,
    })),
    unlistedOutflowWeiPerSec: inputs.unlistedOutflowWeiPerSec,
  };

  return {
    policy,
    committedOutflowWeiPerSec,
    currentOutflowWeiPerSec,
    currentRunwaySec:
      currentOutflowWeiPerSec === 0n || inputs.currentAvailableBalanceWei < 0n
        ? 0n
        : inputs.currentAvailableBalanceWei / currentOutflowWeiPerSec,
    runwayAtCommittedSec:
      inputs.currentAvailableBalanceWei < 0n
        ? 0n
        : inputs.currentAvailableBalanceWei / committedOutflowWeiPerSec,
    restoreThresholdWei,
    alreadyRestorable,
    deficitWei,
    wrapAmountWei,
    resultingBalanceWei,
    resultingDecision: decide(facts, policy),
  };
}
