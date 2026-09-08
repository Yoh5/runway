import { fromSerialisable, type RunRecord } from "../../src/runner/record.js";

/**
 * A run record (the shape `src/runner/` writes into `runs/*.json`) carries
 * everything KeeperHub's response gave the executor: the transaction hash,
 * its explorer link, the gas paid, and the `sponsored` flag when the
 * response carried one. It carries nothing read independently off chain --
 * no block number, no post-write flow rate -- because nothing in the
 * runner's own loop ever reads the chain again after a write lands.
 *
 * Task 10 requires the evidence document to state the block number and the
 * flow rate before and after each adjusted stream, and requires both to be
 * read back off chain rather than taken from the response (a mined receipt
 * proves a transaction landed; only a chain read proves the stream actually
 * changed). That data has to come from somewhere, so the file this module
 * reads is a run record with one extra top-level field, `evidence`, added by
 * hand after the live run's independent verification step (`getFlowInfo`
 * against the CFAv1Forwarder, plus the block number the explorer shows for
 * the transaction). Everything else in the file is the runner's own
 * unmodified output.
 */
export type VerifiedRate = {
  /** Must match (case-insensitively) the receiver of a landed outcome's adjustment. */
  receiver: string;
  /** Read via `getFlowInfo` before the write, as a decimal wei string. */
  beforeWeiPerSec: string;
  /** Read via `getFlowInfo` after the write, as a decimal wei string. */
  afterWeiPerSec: string;
};

export type EvidenceExtras = {
  /** The block the demonstration transaction landed in, as a decimal string. */
  blockNumber: string;
  /** One entry per adjusted stream that actually landed. */
  verifiedRates: VerifiedRate[];
};

export type EvidenceBundle = {
  /** The exact parsed JSON, unmodified -- what `docs/evidence/run.json` becomes. */
  raw: Record<string, unknown>;
  /** The run record revived from `raw`, for handing straight to `renderReport`. */
  record: RunRecord;
  /** The validated `evidence` extras. */
  evidence: EvidenceExtras;
};

export class EvidenceCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceCaptureError";
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidenceCaptureError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyDecimalString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceCaptureError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (!/^\d+$/.test(value)) {
    throw new EvidenceCaptureError(`${what} must be a decimal string (digits only), got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceCaptureError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseVerifiedRate(raw: unknown, index: number): VerifiedRate {
  const r = asRecord(raw, `evidence.verifiedRates[${index}]`);
  return {
    receiver: nonEmptyString(r.receiver, `evidence.verifiedRates[${index}].receiver`),
    beforeWeiPerSec: nonEmptyDecimalString(r.beforeWeiPerSec, `evidence.verifiedRates[${index}].beforeWeiPerSec`),
    afterWeiPerSec: nonEmptyDecimalString(r.afterWeiPerSec, `evidence.verifiedRates[${index}].afterWeiPerSec`),
  };
}

function parseEvidenceExtras(raw: unknown): EvidenceExtras {
  if (raw === undefined) {
    throw new EvidenceCaptureError(
      'the run record has no top-level "evidence" field -- add one with { blockNumber, verifiedRates } ' +
        "populated from the independent chain read (Task 10 step 4: getFlowInfo before and after the write, " +
        "and the block number the explorer shows for the transaction) before capturing evidence",
    );
  }
  const r = asRecord(raw, "evidence");
  const blockNumber = nonEmptyDecimalString(r.blockNumber, "evidence.blockNumber");
  if (!Array.isArray(r.verifiedRates) || r.verifiedRates.length === 0) {
    throw new EvidenceCaptureError(
      "evidence.verifiedRates must be a non-empty array -- one entry per adjusted stream, read back off chain",
    );
  }
  const verifiedRates = r.verifiedRates.map((entry, index) => parseVerifiedRate(entry, index));
  return { blockNumber, verifiedRates };
}

/**
 * Parses and validates one evidence-bearing run record. Throws
 * `EvidenceCaptureError` with an actionable message for every way the file
 * can be incomplete: missing `evidence`, a malformed entry inside it, no
 * landed outcome to have evidence about, or a landed outcome whose receiver
 * has no matching verified-rate entry.
 */
export function parseEvidenceBundle(rawText: string): EvidenceBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new EvidenceCaptureError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = asRecord(parsed, "run record");

  let record: RunRecord;
  try {
    record = fromSerialisable(raw);
  } catch (error) {
    throw new EvidenceCaptureError(
      `does not parse as a run record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const landed = record.outcomes.filter((entry) => entry.outcome.status === "landed");
  if (landed.length === 0) {
    throw new EvidenceCaptureError(
      "this run record has no landed outcome -- there is nothing to capture as a verified demonstration",
    );
  }

  const evidence = parseEvidenceExtras(raw.evidence);

  const verifiedByReceiver = new Map(
    evidence.verifiedRates.map((v) => [v.receiver.toLowerCase(), v] as const),
  );
  const missing = landed
    .map((entry) => entry.adjustment.receiver)
    .filter((receiver) => !verifiedByReceiver.has(receiver.toLowerCase()));
  if (missing.length > 0) {
    throw new EvidenceCaptureError(
      `evidence.verifiedRates has no entry for: ${missing.join(", ")} -- every landed adjustment needs its own before/after chain read`,
    );
  }

  return { raw, record, evidence };
}
