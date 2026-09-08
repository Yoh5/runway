import { describe, expect, it } from "vitest";
import { toSerialisable } from "../../src/runner/record.js";
import type { RunRecord } from "../../src/runner/record.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import { decide } from "../../src/policy/decide.js";
import { EvidenceCaptureError, parseEvidenceBundle } from "../../scripts/lib/capture-evidence.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

function policy(): Policy {
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

const LANDED_DISC = {
  status: "landed" as const,
  transactionHash: "0xabc123",
  transactionLink: "https://sepolia.etherscan.io/tx/0xabc123",
  gasUsedWei: "21000",
  effectiveGasPriceWei: "1000000000",
  sponsored: false,
};

function baseRecord(): RunRecord {
  const f = facts(15_000n, [100n, 100n, 100n]);
  return {
    startedAt: "2026-09-08T12:00:00.000Z",
    nowSec: 1_700_000_000,
    facts: f,
    decision: decide(f, policy()),
    outcomes: [
      {
        adjustment: { receiver: DISC, fromRateWeiPerSec: 100n, toRateWeiPerSec: 0n, reason: "budget-shed" },
        outcome: LANDED_DISC,
      },
    ],
    escalations: [],
  };
}

function rawWithEvidence(over: Record<string, unknown> = {}): Record<string, unknown> {
  const serialised = toSerialisable(baseRecord()) as Record<string, unknown>;
  return {
    ...serialised,
    evidence: {
      blockNumber: "11660123",
      verifiedRates: [{ receiver: DISC, beforeWeiPerSec: "100", afterWeiPerSec: "0" }],
    },
    ...over,
  };
}

describe("parseEvidenceBundle", () => {
  it("parses a valid bundle: revives the run record, keeps raw JSON intact, validates evidence", () => {
    const raw = rawWithEvidence();
    const bundle = parseEvidenceBundle(JSON.stringify(raw));

    expect(bundle.record.startedAt).toBe("2026-09-08T12:00:00.000Z");
    expect(bundle.record.outcomes).toHaveLength(1);
    expect(bundle.record.outcomes[0]?.outcome.status).toBe("landed");
    // Every bigint the runner wrote actually came back as a bigint.
    expect(typeof bundle.record.decision?.runwaySec).toBe("bigint");

    expect(bundle.evidence.blockNumber).toBe("11660123");
    expect(bundle.evidence.verifiedRates).toEqual([
      { receiver: DISC, beforeWeiPerSec: "100", afterWeiPerSec: "0" },
    ]);

    // raw is preserved verbatim -- including the extra `evidence` field --
    // so writing it straight to docs/evidence/run.json loses nothing.
    expect(bundle.raw.evidence).toEqual(raw.evidence);
    expect(bundle.raw.startedAt).toBe("2026-09-08T12:00:00.000Z");
  });

  it("rejects text that is not valid JSON", () => {
    expect(() => parseEvidenceBundle("{not json")).toThrow(EvidenceCaptureError);
  });

  it("rejects a JSON value that is not an object", () => {
    expect(() => parseEvidenceBundle("[1,2,3]")).toThrow(EvidenceCaptureError);
  });

  it("rejects a run record with no top-level evidence field, naming what to add", () => {
    const raw = toSerialisable(baseRecord()) as Record<string, unknown>;
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/evidence/i);
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(EvidenceCaptureError);
  });

  it("rejects evidence.blockNumber missing", () => {
    const raw = rawWithEvidence({ evidence: { verifiedRates: [{ receiver: DISC, beforeWeiPerSec: "100", afterWeiPerSec: "0" }] } });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/blockNumber/);
  });

  it("rejects evidence.blockNumber that is not a decimal string", () => {
    const raw = rawWithEvidence({ evidence: { blockNumber: "eleven million", verifiedRates: [{ receiver: DISC, beforeWeiPerSec: "100", afterWeiPerSec: "0" }] } });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/blockNumber/);
  });

  it("rejects an empty verifiedRates array", () => {
    const raw = rawWithEvidence({ evidence: { blockNumber: "1", verifiedRates: [] } });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/verifiedRates/);
  });

  it("rejects a verifiedRates entry missing afterWeiPerSec", () => {
    const raw = rawWithEvidence({
      evidence: { blockNumber: "1", verifiedRates: [{ receiver: DISC, beforeWeiPerSec: "100" }] },
    });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/afterWeiPerSec/);
  });

  it("rejects a run record with no landed outcome -- nothing to capture", () => {
    const record = baseRecord();
    const noLandedRecord: RunRecord = {
      ...record,
      outcomes: [
        {
          adjustment: { receiver: DISC, fromRateWeiPerSec: 100n, toRateWeiPerSec: 0n, reason: "budget-shed" },
          outcome: { status: "refused", stage: "simulate", detail: "insufficient allowance" },
        },
      ],
    };
    const raw = {
      ...(toSerialisable(noLandedRecord) as Record<string, unknown>),
      evidence: { blockNumber: "1", verifiedRates: [{ receiver: DISC, beforeWeiPerSec: "100", afterWeiPerSec: "0" }] },
    };
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(/no landed outcome/);
  });

  it("rejects when a landed outcome's receiver has no matching verified-rate entry", () => {
    const raw = rawWithEvidence({
      evidence: {
        blockNumber: "1",
        verifiedRates: [{ receiver: CRIT, beforeWeiPerSec: "100", afterWeiPerSec: "80" }],
      },
    });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).toThrow(new RegExp(DISC));
  });

  it("matches verifiedRates receivers case-insensitively", () => {
    const raw = rawWithEvidence({
      evidence: {
        blockNumber: "1",
        verifiedRates: [{ receiver: DISC.toUpperCase(), beforeWeiPerSec: "100", afterWeiPerSec: "0" }],
      },
    });
    expect(() => parseEvidenceBundle(JSON.stringify(raw))).not.toThrow();
  });
});
