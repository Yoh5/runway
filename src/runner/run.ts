import { decide } from "../policy/decide.js";
import type { Adjustment, Facts, Policy } from "../policy/types.js";
import type { ExecutionOutcome } from "../keeperhub/execute.js";
import { reason } from "../redact.js";
import { deliverEscalation } from "./escalate.js";
import type { RunRecord } from "./record.js";

/**
 * Every collaborator the runner needs, as a function. This is what keeps the
 * runner's own tests off the network and away from constructing any real
 * client: a test only ever has to supply plain async functions.
 */
export type RunDeps = {
  readFacts: (policy: Policy, nowSec: number) => Promise<Facts>;
  execute: (policy: Policy, adjustment: Adjustment, nowSec: number) => Promise<ExecutionOutcome>;
  notify: (webhook: string, payload: unknown) => Promise<void>;
};

/**
 * Runs one tick: read the chain, decide, act, escalate, and write down
 * exactly what happened. Contains no policy of its own — `decide` is the only
 * place a rate is chosen — this function only wires the pieces in order and
 * records the result.
 *
 * Fails closed: a `readFacts` failure (the reader only ever throws
 * `ReadIncompleteError`, but any thrown error is treated the same way) ends
 * the run with no decision taken, no execution attempted, and a run-level
 * "read-incomplete" escalation.
 *
 * A `hold` decision performs zero writes — not zero *effective* writes, zero
 * calls to `execute` at all, since gas costs money on every call regardless
 * of outcome. Every other decision executes its adjustments in the order
 * `decide` listed them, and a refusal partway through does not stop the
 * rest: each adjustment only ever moves a rate toward a stated committed
 * value, so each is independently safe, and the next tick recomputes from
 * fresh facts regardless.
 *
 * Run-level escalations (raised here or by the executor, distinct from the
 * two `decide` itself can raise): "read-incomplete" (above), "mandate-
 * rejected" for a refused write, and "write-outcome-unknown" for an
 * unresolved write that carries a transaction hash -- the one state in
 * which the treasury may have paid and this run cannot say whether it did.
 * An unresolved outcome with no hash (e.g. a socket error before anything
 * was sent) is an ordinary unknown and does not escalate.
 */
export async function runOnce(deps: RunDeps, policy: Policy, nowSec: number): Promise<RunRecord> {
  const record: RunRecord = {
    startedAt: new Date().toISOString(),
    nowSec,
    facts: null,
    decision: null,
    outcomes: [],
    escalations: [],
  };

  let facts: Facts;
  try {
    facts = await deps.readFacts(policy, nowSec);
  } catch (error) {
    record.escalations.push(
      await deliverEscalation(deps.notify, policy.escalation.webhook, "read-incomplete", reason(error)),
    );
    return record;
  }
  record.facts = facts;

  const decision = decide(facts, policy);
  record.decision = decision;

  if (decision.escalation) {
    record.escalations.push(
      await deliverEscalation(
        deps.notify,
        policy.escalation.webhook,
        decision.escalation.kind,
        decision.escalation.detail,
      ),
    );
  }

  if (decision.kind === "hold") {
    return record;
  }

  let anyRefused = false;
  for (const adjustment of decision.adjustments) {
    const outcome = await deps.execute(policy, adjustment, nowSec);
    record.outcomes.push({ adjustment, outcome });
    if (outcome.status === "refused") anyRefused = true;

    // An unresolved outcome with a transaction hash means the write may have
    // reached the chain even though we cannot confirm it -- unlike a plain
    // refusal (nothing happened) this is the one state where money may have
    // moved silently, so it escalates on its own, per outcome, carrying the
    // hash and receiver a human needs to look the transaction up. `detail`
    // already passed through `executeAdjustment`'s `safeText` (the executor
    // is the only place holding the API key and RPC URL to redact against),
    // so composing it in here carries that redaction forward rather than
    // bypassing it.
    if (outcome.status === "unresolved" && outcome.transactionHash) {
      record.escalations.push(
        await deliverEscalation(
          deps.notify,
          policy.escalation.webhook,
          "write-outcome-unknown",
          `adjustment for ${adjustment.receiver} is unresolved with transaction hash ${outcome.transactionHash} -- the treasury may have paid and this cannot confirm it: ${outcome.detail}`,
        ),
      );
    }
  }

  if (anyRefused) {
    record.escalations.push(
      await deliverEscalation(
        deps.notify,
        policy.escalation.webhook,
        "mandate-rejected",
        "one or more adjustments were refused by KeeperHub; see outcomes for detail",
      ),
    );
  }

  return record;
}
