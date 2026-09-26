import { createHash } from "node:crypto";
import { decide } from "../policy/decide.js";
import type { Policy } from "../policy/types.js";
import type { RunRecord } from "./record.js";

/**
 * A stable digest of the policy a run was decided under. Recorded on every
 * run from here on, so a reader can tell whether the file they are holding is
 * the one that produced that decision — a policy edited after the fact would
 * otherwise make an honest record look wrong, and a dishonest one look right.
 */
export function policyDigest(policy: Policy): string {
  // Everything that decides, and nothing else. `escalation` is delivery
  // configuration: where an alert is sent has no influence on any rate, and
  // its webhook is resolved from the environment -- so hashing it made the
  // digest depend on which shell computed it. A real tick stamped a record
  // with the webhook set, and `verify-record`, run without it, rejected an
  // honest record. Two operators of the same policy must agree on its digest.
  const { escalation: _delivery, ...decides } = policy;
  const canonical = JSON.stringify(decides, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type RecordVerdict = { startedAt: string; ok: boolean; detail: string };

function canonicalise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Re-decides a recorded run from the facts it recorded, and checks the
 * decision it claims against the one the policy actually produces.
 *
 * A run record already says what happened. This says something stronger: that
 * what happened follows from what was seen, by a rule anyone holding the
 * policy file can apply themselves. `decide` is pure, so the check is exact —
 * same facts, same policy, same decision, every time.
 *
 * It also checks the other direction, which is the one an auditor cares about:
 * every write executed must map to an adjustment the decision named. A write
 * with no decision behind it is the one thing a record must never be able to
 * hide. The converse is allowed — a decided adjustment that was never
 * executed means the executor refused or the run ended, and refusing to write
 * is always safe.
 */
export function verifyRecord(record: RunRecord, policy: Policy): RecordVerdict {
  const verdict = (ok: boolean, detail: string): RecordVerdict => ({
    startedAt: record.startedAt,
    ok,
    detail,
  });

  if (record.policyDigest && record.policyDigest !== policyDigest(policy)) {
    return verdict(
      false,
      `recorded policy digest ${record.policyDigest} is not the policy given; check the run against the policy it actually ran under`,
    );
  }

  if (record.facts === null) {
    if (record.decision !== null) {
      return verdict(false, "a decision was recorded without the facts it was taken from");
    }
    return verdict(true, "no facts recorded: the read failed and no decision was taken");
  }

  if (record.decision === null) {
    return verdict(false, "facts were recorded but no decision: a tick that read must decide");
  }

  const expected = decide(record.facts, policy);
  if (canonicalise(expected) !== canonicalise(record.decision)) {
    return verdict(
      false,
      `decision does not follow from the recorded facts: expected ${expected.kind} with ${expected.adjustments.length} adjustment(s), record claims ${record.decision.kind} with ${record.decision.adjustments.length}`,
    );
  }

  const decided = new Set(record.decision.adjustments.map((a) => canonicalise(a)));
  const unmapped = record.outcomes
    .map(({ adjustment }) => adjustment)
    .filter((adjustment) => !decided.has(canonicalise(adjustment)));
  if (unmapped.length > 0) {
    return verdict(
      false,
      `${unmapped.length} write(s) unmapped to the decision: ${unmapped.map((a) => a.receiver).join(", ")}`,
    );
  }

  // A record without a digest was checked against whichever policy the caller
  // happened to pass. That check is still worth making, but a reader must not
  // mistake it for proof that this policy is the one that ran.
  const assumed = record.policyDigest
    ? ""
    : " (no policy digest recorded: checked against an assumed policy)";

  return verdict(
    true,
    `${record.decision.kind}, ${record.decision.adjustments.length} adjustment(s), ${record.outcomes.length} write(s), all mapped${assumed}`,
  );
}
