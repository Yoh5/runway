import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import { loadPolicy } from "../../src/policy/load.js";
import type { Facts } from "../../src/policy/types.js";
import { planStreams } from "../../scripts/lib/plan.js";
import { ETHX_ADDRESS, TREASURY_ADDRESS } from "../../scripts/lib/superfluid.js";

/**
 * "No count produced by a run is written into any document unless a test
 * reads it back off the source" (docs/superpowers/specs/2026-09-06-runway-
 * design.md, section 10). `policies/treasury.sepolia.yaml` carries figures
 * `plan-streams.ts` printed from a live Sepolia read on 2026-09-07; this
 * reads the committed file back and checks it against the same pure
 * `planStreams` call with the recorded inputs (see docs/SETUP.md), so a hand
 * edit that drifts from the arithmetic fails here instead of surfacing on
 * chain as a bad `createFlow`.
 */
function policyPath(): string {
  return fileURLToPath(new URL("../../policies/treasury.sepolia.yaml", import.meta.url));
}

describe("policies/treasury.sepolia.yaml", () => {
  it("parses as a valid policy", () => {
    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);
    expect(policy.chainId).toBe(11155111);
    expect(policy.token).toBe(ETHX_ADDRESS.toLowerCase());
    expect(policy.sender).toBe(TREASURY_ADDRESS.toLowerCase());
    expect(policy.recipients).toHaveLength(3);
  });

  it("gives every recipient a non-zero floor -- a zero floor is a one-way door (spec section 5)", () => {
    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);
    expect(policy.recipients).toHaveLength(3);
    for (const recipient of policy.recipients) {
      expect(recipient.floorRateWeiPerSec).toBeGreaterThan(0n);
    }
  });

  it("every recipient's rates match scripts/plan-streams.ts's arithmetic for the recorded block-11656065 read", () => {
    const plan = planStreams({
      treasuryEthWei: 601_000_000_000_000_000n,
      gasReserveWei: 350_000_000_000_000_000n,
      targetRunwaySec: 168n * 3600n,
      hysteresisSec: 24n * 3600n,
      liquidationPeriodSec: 3600n,
      marginPercent: 25n,
      tierWeights: [5n, 3n, 2n],
      tierFloorPercents: [60n, 25n, 20n],
    });

    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);

    for (const stream of plan.streams) {
      const recipient = policy.recipients.find((r) => r.tier === stream.tier);
      expect(recipient?.committedRateWeiPerSec).toBe(stream.committedRateWeiPerSec);
      expect(recipient?.floorRateWeiPerSec).toBe(stream.floorRateWeiPerSec);
    }
  });

  it("the runway at committed rates clears targetRunwayHours + hysteresisHours", () => {
    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);
    const committedTotal = policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n);
    const liquidationPeriodSec = 3600n;
    const wrapAmountWei = 251_000_000_000_000_000n; // treasuryEthWei - gasReserveWei, recorded in docs/SETUP.md
    const totalBufferWei = committedTotal * liquidationPeriodSec;
    const runwayAtCommittedSec = (wrapAmountWei - totalBufferWei) / committedTotal;
    expect(runwayAtCommittedSec > policy.targetRunwaySec + policy.hysteresisSec).toBe(true);
  });

  /**
   * The whole point of a non-zero standard floor (spec section 5): a budget
   * squeeze severe enough to breach minRunwayHours must be able to shed the
   * standard tier down toward its floor -- never to zero, since a rate-zero
   * stream can't be restored under a permissions:6 (update|delete, no
   * create) mandate. 0.0502 ETH is 20% of the 0.251 ETH this policy wraps
   * (docs/SETUP.md section 3) -- a plausible fraction of the treasury's
   * ETHx to have drawn down to by the time a keeper tick sees this balance,
   * well under the ~0.075 ETH (minRunwayHours=72 x totalCommittedRate)
   * boundary below which `decide` starts shedding at all, and also under
   * the ~0.147 ETH budget boundary above which the standard tier would never
   * be touched (need = totalCommittedRate - budget must exceed
   * discretionary's reducible range, 46288612264 wei/sec, before standard is
   * touched at all).
   */
  it("a plausible budget squeeze sheds the standard tier down to its floor, never to zero", () => {
    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);

    const availableBalanceWei = 50_200_000_000_000_000n; // 0.0502 ETH = 20% of the 0.251 ETH wrap
    const facts: Facts = {
      nowSec: 1_700_000_000,
      availableBalanceWei,
      depositWei: 0n,
      streams: policy.recipients.map((r) => ({
        receiver: r.address,
        flowRateWeiPerSec: r.committedRateWeiPerSec,
      })),
      unlistedOutflowWeiPerSec: 0n,
    };

    const decision = decide(facts, policy);
    expect(decision.kind).toBe("reduce");
    expect(decision.breach).toBe(true);

    const discretionary = policy.recipients.find((r) => r.tier === "discretionary");
    const standard = policy.recipients.find((r) => r.tier === "standard");
    if (!discretionary || !standard) throw new Error("policy is missing a tier");

    const discretionaryAdjustment = decision.adjustments.find(
      (a) => a.receiver === discretionary.address,
    );
    const standardAdjustment = decision.adjustments.find((a) => a.receiver === standard.address);

    // Cascade order: discretionary is fully shed to its own floor before
    // standard is touched at all (invariant 4 in tests/policy/invariants.test.ts).
    expect(discretionaryAdjustment?.toRateWeiPerSec).toBe(discretionary.floorRateWeiPerSec);

    // The property this test exists for: the shed visibly reaches standard
    // (its rate drops below what was committed) and stops at its floor --
    // a positive rate, never the zero this task's fix rules out.
    expect(standardAdjustment).toBeDefined();
    expect(standardAdjustment?.toRateWeiPerSec).toBe(standard.floorRateWeiPerSec);
    expect(standardAdjustment?.toRateWeiPerSec).toBeGreaterThan(0n);
    expect(standardAdjustment?.toRateWeiPerSec).toBeLessThan(standard.committedRateWeiPerSec);
  });
});
