import type { Tier } from "../../src/policy/types.js";

/**
 * Pure sizing arithmetic for the three demo streams. No network, no
 * filesystem, no clock -- every quantity the caller needs (the treasury's
 * balance, the policy's thresholds, the liquidation period) arrives as an
 * argument, exactly like `src/policy/decide.ts`. This is what makes it
 * unit-testable without a chain.
 */

export type PlanInputs = {
  /** The treasury's whole ETH balance, in wei, read live from the chain. */
  treasuryEthWei: bigint;
  /** ETH wei kept unwrapped, as a gas cushion for the five setup signatures. */
  gasReserveWei: bigint;
  /** Policy thresholds, already in seconds -- matches `Policy` in src/policy/types.ts. */
  targetRunwaySec: bigint;
  hysteresisSec: bigint;
  /** Superfluid's per-stream deposit window for this token, read live from governance. */
  liquidationPeriodSec: bigint;
  /**
   * How far above `targetRunwaySec + hysteresisSec` the plan aims to land,
   * as a whole-number percentage (25n means 25% above). Without this margin
   * a plan that lands exactly on the boundary would flip to "restore" or
   * "hold" depending only on integer-division rounding; the margin keeps the
   * first dry run unambiguously inside "hold".
   */
  marginPercent: bigint;
  /**
   * Splits the total committed rate across [critical, standard,
   * discretionary], most senior first. Any three positive weights work; the
   * ratio determines how visibly distinct the three rates are.
   */
  tierWeights: readonly [bigint, bigint, bigint];
  /**
   * Each tier's floor as a percentage of its own committed rate, same order
   * as `tierWeights`. The discretionary entry must be > 0: a zero floor lets
   * a shed close that stream for good, and Runway's mandate (permissions:
   * update | delete, never create) can never reopen it.
   */
  tierFloorPercents: readonly [bigint, bigint, bigint];
};

export type PlannedStream = {
  tier: Tier;
  committedRateWeiPerSec: bigint;
  floorRateWeiPerSec: bigint;
  bufferWei: bigint;
};

export type Plan = {
  wrapAmountWei: bigint;
  streams: readonly [PlannedStream, PlannedStream, PlannedStream];
  totalCommittedRateWeiPerSec: bigint;
  totalBufferWei: bigint;
  /**
   * `(wrapAmountWei - totalBufferWei) / totalCommittedRateWeiPerSec`, using
   * integer (floor) division -- the exact expression `considerRestore` in
   * `src/policy/decide.ts` evaluates as `runwayAtCommitted` once the three
   * streams are opened at these committed rates.
   */
  runwayAtCommittedSec: bigint;
};

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

const TIERS: readonly [Tier, Tier, Tier] = ["critical", "standard", "discretionary"];

export function planStreams(inputs: PlanInputs): Plan {
  const wrapAmountWei = inputs.treasuryEthWei - inputs.gasReserveWei;
  if (wrapAmountWei <= 0n) {
    throw new PlanError(
      `gas reserve (${inputs.gasReserveWei} wei) leaves nothing to wrap out of a ${inputs.treasuryEthWei} wei balance`,
    );
  }

  // Solve totalRate from the same expression decide.ts uses for
  // runwayAtCommitted: (wrapAmountWei - liquidationPeriodSec * totalRate) / totalRate == desiredRunwaySec
  //   => wrapAmountWei / totalRate == desiredRunwaySec + liquidationPeriodSec
  //   => totalRate == wrapAmountWei / (desiredRunwaySec + liquidationPeriodSec)
  const desiredRunwaySec =
    ((inputs.targetRunwaySec + inputs.hysteresisSec) * (100n + inputs.marginPercent)) / 100n;
  const totalCommittedRateWeiPerSec = wrapAmountWei / (desiredRunwaySec + inputs.liquidationPeriodSec);
  if (totalCommittedRateWeiPerSec <= 0n) {
    throw new PlanError(
      `wrap amount ${wrapAmountWei} wei is too small to fund any positive flow rate at a ${desiredRunwaySec}s runway target`,
    );
  }

  const weightSum = inputs.tierWeights[0] + inputs.tierWeights[1] + inputs.tierWeights[2];
  if (weightSum <= 0n) throw new PlanError("tierWeights must sum to a positive number");

  const criticalRate = (totalCommittedRateWeiPerSec * inputs.tierWeights[0]) / weightSum;
  const standardRate = (totalCommittedRateWeiPerSec * inputs.tierWeights[1]) / weightSum;
  // Remainder to discretionary (the last tier), not a fresh division, so the
  // three rates sum to exactly totalCommittedRateWeiPerSec -- the figure the
  // affordability check just below was computed against.
  const discretionaryRate = totalCommittedRateWeiPerSec - criticalRate - standardRate;

  if (!(criticalRate > standardRate && standardRate > discretionaryRate && discretionaryRate > 0n)) {
    throw new PlanError(
      `tier rates are not strictly decreasing and positive (critical ${criticalRate}, standard ${standardRate}, discretionary ${discretionaryRate}) -- adjust tierWeights or the wrap amount`,
    );
  }

  const rates: readonly [bigint, bigint, bigint] = [criticalRate, standardRate, discretionaryRate];
  const streams = TIERS.map((tier, i) => {
    const committedRateWeiPerSec = rates[i] as bigint;
    const floorRateWeiPerSec =
      (committedRateWeiPerSec * (inputs.tierFloorPercents[i] as bigint)) / 100n;
    return {
      tier,
      committedRateWeiPerSec,
      floorRateWeiPerSec,
      bufferWei: committedRateWeiPerSec * inputs.liquidationPeriodSec,
    };
  }) as unknown as [PlannedStream, PlannedStream, PlannedStream];

  const discretionaryFloor = streams[2].floorRateWeiPerSec;
  if (discretionaryFloor <= 0n) {
    throw new PlanError(
      "discretionary floor computed as zero -- a shed could close that stream for good and the mandate could never reopen it",
    );
  }

  const totalBufferWei = streams.reduce((sum, s) => sum + s.bufferWei, 0n);
  const availableAfterBuffer = wrapAmountWei - totalBufferWei;
  if (availableAfterBuffer <= 0n) {
    throw new PlanError(
      `stream buffers (${totalBufferWei} wei total) leave nothing of the ${wrapAmountWei} wei wrapped -- create-flow would revert with CFA_INSUFFICIENT_BALANCE`,
    );
  }

  const runwayAtCommittedSec = availableAfterBuffer / totalCommittedRateWeiPerSec;

  return {
    wrapAmountWei,
    streams,
    totalCommittedRateWeiPerSec,
    totalBufferWei,
    runwayAtCommittedSec,
  };
}
