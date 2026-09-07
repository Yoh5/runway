import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../../src/policy/load.js";
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

  it("gives the discretionary recipient a non-zero floor", () => {
    const yamlText = readFileSync(policyPath(), "utf8");
    const policy = loadPolicy(yamlText);
    const discretionary = policy.recipients.find((r) => r.tier === "discretionary");
    expect(discretionary?.floorRateWeiPerSec).toBeGreaterThan(0n);
  });

  it("every recipient's rates match scripts/plan-streams.ts's arithmetic for the recorded block-11656065 read", () => {
    const plan = planStreams({
      treasuryEthWei: 601_000_000_000_000_000n,
      gasReserveWei: 100_000_000_000_000_000n,
      targetRunwaySec: 168n * 3600n,
      hysteresisSec: 24n * 3600n,
      liquidationPeriodSec: 3600n,
      marginPercent: 25n,
      tierWeights: [5n, 3n, 2n],
      tierFloorPercents: [60n, 0n, 20n],
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
    const wrapAmountWei = 501_000_000_000_000_000n; // treasuryEthWei - gasReserveWei, recorded in docs/SETUP.md
    const totalBufferWei = committedTotal * liquidationPeriodSec;
    const runwayAtCommittedSec = (wrapAmountWei - totalBufferWei) / committedTotal;
    expect(runwayAtCommittedSec > policy.targetRunwaySec + policy.hysteresisSec).toBe(true);
  });
});
