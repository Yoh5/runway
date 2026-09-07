import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PlanError, type PlanInputs, planStreams } from "../../scripts/lib/plan.js";

/** The real Sepolia sizing this task ran on 2026-09-07 (see docs/SETUP.md). */
function realInputs(): PlanInputs {
  return {
    treasuryEthWei: 601_000_000_000_000_000n, // 0.601 ETH, live treasury balance
    gasReserveWei: 100_000_000_000_000_000n, // 0.1 ETH kept unwrapped for the five signatures
    targetRunwaySec: 168n * 3600n,
    hysteresisSec: 24n * 3600n,
    liquidationPeriodSec: 3600n, // governance PPPConfiguration, read live
    marginPercent: 25n,
    tierWeights: [5n, 3n, 2n],
    tierFloorPercents: [60n, 0n, 20n],
  };
}

describe("planStreams -- the real Sepolia sizing", () => {
  it("matches the hand-computed arithmetic for the actual treasury balance", () => {
    const plan = planStreams(realInputs());
    expect(plan.wrapAmountWei).toBe(501_000_000_000_000_000n);
    expect(plan.streams[0]).toEqual({
      tier: "critical",
      committedRateWeiPerSec: 288_727_524_204n,
      floorRateWeiPerSec: 173_236_514_522n,
      bufferWei: 1_039_419_087_134_400n,
    });
    expect(plan.streams[1]).toEqual({
      tier: "standard",
      committedRateWeiPerSec: 173_236_514_522n,
      floorRateWeiPerSec: 0n,
      bufferWei: 623_651_452_279_200n,
    });
    expect(plan.streams[2]).toEqual({
      tier: "discretionary",
      committedRateWeiPerSec: 115_491_009_683n,
      floorRateWeiPerSec: 23_098_201_936n,
      bufferWei: 415_767_634_858_800n,
    });
    expect(plan.totalCommittedRateWeiPerSec).toBe(577_455_048_409n);
    expect(plan.totalBufferWei).toBe(2_078_838_174_272_400n);
    // The headline requirement: comfortably above targetRunwayHours (168) +
    // hysteresisHours (24) = 192h = 691200s. This lands at exactly the 25%
    // margin the inputs ask for: 240h = 864000s.
    expect(plan.runwayAtCommittedSec).toBe(864_000n);
  });

  it("the three committed rates sum to the total the runway was computed from", () => {
    const plan = planStreams(realInputs());
    const sum = plan.streams.reduce((s, r) => s + r.committedRateWeiPerSec, 0n);
    expect(sum).toBe(plan.totalCommittedRateWeiPerSec);
  });

  it("wrapping plus the gas reserve accounts for the whole treasury balance", () => {
    const inputs = realInputs();
    const plan = planStreams(inputs);
    expect(plan.wrapAmountWei + inputs.gasReserveWei).toBe(inputs.treasuryEthWei);
  });
});

describe("planStreams -- errors", () => {
  it("refuses a discretionary floor of zero", () => {
    const inputs = { ...realInputs(), tierFloorPercents: [60n, 0n, 0n] as const };
    expect(() => planStreams(inputs)).toThrow(PlanError);
    expect(() => planStreams(inputs)).toThrow(/discretionary floor/);
  });

  it("refuses a gas reserve that consumes the whole balance", () => {
    const inputs = { ...realInputs(), gasReserveWei: realInputs().treasuryEthWei };
    expect(() => planStreams(inputs)).toThrow(PlanError);
  });
});

/**
 * Property coverage: given ANY treasury balance and ANY policy thresholds
 * (within a realistic range), the plan this function produces -- whenever it
 * can produce one at all -- satisfies the runway inequality the brief states
 * as the headline requirement, plus the accounting and ordering invariants
 * that make the plan usable as a real policy file. A `PlanError` means the
 * inputs could not fund a sane plan (e.g. the wrap amount is too small to
 * split into three distinct positive rates); that is a legitimate outcome
 * for an adversarial draw, not a property violation, so those draws are
 * skipped rather than asserted on.
 */
type Scenario = {
  treasuryEthWei: bigint;
  gasReserveFractionPercent: number;
  targetHours: number;
  hysteresisHours: number;
  liquidationPeriodSec: number;
  marginPercent: number;
  tierWeights: [number, number, number];
  discretionaryFloorPercent: number;
  criticalFloorPercent: number;
  standardFloorPercent: number;
};

const scenario: fc.Arbitrary<Scenario> = fc.record({
  treasuryEthWei: fc.bigInt({ min: 10n ** 15n, max: 10n ** 21n }),
  gasReserveFractionPercent: fc.integer({ min: 0, max: 20 }),
  targetHours: fc.integer({ min: 1, max: 500 }),
  hysteresisHours: fc.integer({ min: 1, max: 200 }),
  liquidationPeriodSec: fc.integer({ min: 60, max: 86_400 }),
  marginPercent: fc.integer({ min: 1, max: 200 }),
  tierWeights: fc.tuple(
    fc.integer({ min: 3, max: 10 }),
    fc.integer({ min: 2, max: 9 }),
    fc.integer({ min: 1, max: 8 }),
  ),
  discretionaryFloorPercent: fc.integer({ min: 1, max: 100 }),
  criticalFloorPercent: fc.integer({ min: 0, max: 100 }),
  standardFloorPercent: fc.integer({ min: 0, max: 100 }),
});

function toInputs(s: Scenario): PlanInputs {
  const gasReserveWei = (s.treasuryEthWei * BigInt(s.gasReserveFractionPercent)) / 100n;
  return {
    treasuryEthWei: s.treasuryEthWei,
    gasReserveWei,
    targetRunwaySec: BigInt(s.targetHours) * 3600n,
    hysteresisSec: BigInt(s.hysteresisHours) * 3600n,
    liquidationPeriodSec: BigInt(s.liquidationPeriodSec),
    marginPercent: BigInt(s.marginPercent),
    tierWeights: [BigInt(s.tierWeights[0]), BigInt(s.tierWeights[1]), BigInt(s.tierWeights[2])],
    tierFloorPercents: [
      BigInt(s.criticalFloorPercent),
      BigInt(s.standardFloorPercent),
      BigInt(s.discretionaryFloorPercent),
    ],
  };
}

describe("planStreams -- properties over arbitrary balances and thresholds", () => {
  it("runway at committed rates lands strictly above targetRunwaySec + hysteresisSec", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        expect(plan.runwayAtCommittedSec > inputs.targetRunwaySec + inputs.hysteresisSec).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("every stream's buffer is affordable: the three buffers never exceed the wrapped amount", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        expect(plan.totalBufferWei < plan.wrapAmountWei).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("tier rates are strictly decreasing: critical > standard > discretionary > 0", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        const [critical, standard, discretionary] = plan.streams;
        expect(critical.committedRateWeiPerSec > standard.committedRateWeiPerSec).toBe(true);
        expect(standard.committedRateWeiPerSec > discretionary.committedRateWeiPerSec).toBe(true);
        expect(discretionary.committedRateWeiPerSec > 0n).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("the discretionary floor is always positive -- a shed can never close it for good", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        expect(plan.streams[2].floorRateWeiPerSec).toBeGreaterThan(0n);
      }),
      { numRuns: 1000 },
    );
  });

  it("no stream's floor exceeds its own committed rate", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        for (const stream of plan.streams) {
          expect(stream.floorRateWeiPerSec <= stream.committedRateWeiPerSec).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("wrapping plus the gas reserve never exceeds the treasury balance", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const inputs = toInputs(s);
        let plan: ReturnType<typeof planStreams>;
        try {
          plan = planStreams(inputs);
        } catch (error) {
          if (error instanceof PlanError) return;
          throw error;
        }
        expect(plan.wrapAmountWei + inputs.gasReserveWei).toBe(inputs.treasuryEthWei);
      }),
      { numRuns: 1000 },
    );
  });
});
