import type { Address, Adjustment, Decision, Escalation, Facts, Stream } from "../policy/types.js";
import type { ExecutionOutcome } from "../keeperhub/execute.js";

/** One escalation the run either delivered to the webhook or failed to. */
export type RunEscalation = { kind: string; detail: string; delivered: boolean };

export type RunRecord = {
  startedAt: string;
  nowSec: number;
  facts: Facts | null;
  decision: Decision | null;
  outcomes: { adjustment: Adjustment; outcome: ExecutionOutcome }[];
  escalations: RunEscalation[];
};

/**
 * Deep-converts every `bigint` in a value to a decimal string. This is the
 * single place that conversion happens: a `bigint` reaching `JSON.stringify`
 * unhandled throws, so nothing downstream of a `RunRecord` — the file writer,
 * a report renderer, a future consumer — has to remember to do this itself.
 */
function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, serialise(v)]),
    );
  }
  return value;
}

export function toSerialisable(record: RunRecord): unknown {
  return serialise(record);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a run record object");
  }
  return value as Record<string, unknown>;
}

function reviveStream(raw: unknown): Stream {
  const r = asRecord(raw);
  return {
    receiver: r.receiver as Address,
    flowRateWeiPerSec: BigInt(r.flowRateWeiPerSec as string),
  };
}

function reviveFacts(raw: unknown): Facts | null {
  if (raw === null) return null;
  const r = asRecord(raw);
  return {
    nowSec: r.nowSec as number,
    availableBalanceWei: BigInt(r.availableBalanceWei as string),
    depositWei: BigInt(r.depositWei as string),
    streams: (r.streams as unknown[]).map(reviveStream),
    unlistedOutflowWeiPerSec: BigInt(r.unlistedOutflowWeiPerSec as string),
  };
}

function reviveAdjustment(raw: unknown): Adjustment {
  const r = asRecord(raw);
  return {
    receiver: r.receiver as Address,
    fromRateWeiPerSec: BigInt(r.fromRateWeiPerSec as string),
    toRateWeiPerSec: BigInt(r.toRateWeiPerSec as string),
    reason: r.reason as Adjustment["reason"],
  };
}

function reviveDecision(raw: unknown): Decision | null {
  if (raw === null) return null;
  const r = asRecord(raw);
  return {
    kind: r.kind as Decision["kind"],
    runwaySec: r.runwaySec === null ? null : BigInt(r.runwaySec as string),
    breach: r.breach as boolean,
    adjustments: (r.adjustments as unknown[]).map(reviveAdjustment),
    escalation: r.escalation as Escalation | null,
  };
}

function reviveOutcomeEntry(raw: unknown): { adjustment: Adjustment; outcome: ExecutionOutcome } {
  const r = asRecord(raw);
  return {
    adjustment: reviveAdjustment(r.adjustment),
    // ExecutionOutcome carries no bigint field of its own -- gasUsedWei and
    // effectiveGasPriceWei are decimal strings when present on the "landed"
    // variant (optional: KeeperHub's new response contract reports neither),
    // so it round-trips through JSON with no revival needed either way.
    outcome: r.outcome as ExecutionOutcome,
  };
}

/**
 * The inverse of `toSerialisable`: rebuilds a `RunRecord` from the plain JSON
 * value `JSON.parse` hands back (as read off disk from `runs/*.json`),
 * reviving every field the real `RunRecord` type carries as a `bigint`. Not a
 * blind "every numeric string becomes a bigint" walk -- an address, a label,
 * a transaction hash, an ISO timestamp and an escalation detail are all
 * strings that must stay strings -- so this knows the exact shape of a
 * `RunRecord` and revives only the fields that were bigints before
 * `toSerialisable` ran.
 */
export function fromSerialisable(value: unknown): RunRecord {
  const r = asRecord(value);
  return {
    startedAt: r.startedAt as string,
    nowSec: r.nowSec as number,
    facts: reviveFacts(r.facts),
    decision: reviveDecision(r.decision),
    outcomes: (r.outcomes as unknown[]).map(reviveOutcomeEntry),
    escalations: r.escalations as RunEscalation[],
  };
}
