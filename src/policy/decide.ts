import {
  type Adjustment,
  type Decision,
  type Escalation,
  type Facts,
  type Policy,
  type Recipient,
  TIER_ORDER,
} from "./types.js";

function indexRecipients(policy: Policy): Map<string, Recipient> {
  return new Map(policy.recipients.map((r) => [r.address, r]));
}

/**
 * Streams the policy knows about, in the order the shed walks them: tier
 * first, then descending rate, then address. Address is the final key so the
 * order is total and two runs on identical facts cannot disagree.
 */
function shedOrder(facts: Facts, policy: Policy): { recipient: Recipient; rate: bigint }[] {
  const byAddress = indexRecipients(policy);
  const known = facts.streams
    .map((s) => {
      const recipient = byAddress.get(s.receiver);
      return recipient ? { recipient, rate: s.flowRateWeiPerSec } : null;
    })
    .filter((e): e is { recipient: Recipient; rate: bigint } => e !== null);

  return known.sort((a, b) => {
    const tierDelta =
      TIER_ORDER.indexOf(a.recipient.tier) - TIER_ORDER.indexOf(b.recipient.tier);
    if (tierDelta !== 0) return tierDelta;
    if (a.rate !== b.rate) return a.rate > b.rate ? -1 : 1;
    return a.recipient.address < b.recipient.address ? -1 : 1;
  });
}

/**
 * The treasury has recovered enough to raise streams back toward what it
 * committed to, or is merely oscillating around the target and should be
 * left alone. `runwaySec` is `null` when the caller has no net outflow to
 * report a runway for (every stream is currently at zero).
 */
function considerRestore(facts: Facts, policy: Policy, runwaySec: bigint | null): Decision {
  const hold: Decision = {
    kind: "hold",
    runwaySec,
    breach: false,
    adjustments: [],
    escalation: null,
  };

  const committedOutflow = policy.recipients.reduce(
    (sum, r) => sum + r.committedRateWeiPerSec,
    0n,
  );

  // The band is measured at committed rates, not at today's degraded rates:
  // the question is whether the treasury can afford what it originally agreed
  // to pay, not whether it can afford what it is currently paying. Unlisted
  // outflow is real drain Runway has no mandate over and never adjusts, but
  // it still has to be counted, or restoring can raise listed streams back up
  // while the true (listed + unlisted) runway stays short.
  const committedTotal = committedOutflow + facts.unlistedOutflowWeiPerSec;
  if (committedTotal === 0n) return hold;
  const runwayAtCommitted = facts.availableBalanceWei / committedTotal;
  if (runwayAtCommitted < policy.targetRunwaySec + policy.hysteresisSec) return hold;

  const currentRate = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
  const restoreOrder = [...policy.recipients].sort((a, b) => {
    const tierDelta = TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier);
    if (tierDelta !== 0) return tierDelta;
    return a.address < b.address ? -1 : 1;
  });

  const adjustments: Adjustment[] = [];
  for (const recipient of restoreOrder) {
    const rate = currentRate.get(recipient.address) ?? 0n;
    if (rate === recipient.committedRateWeiPerSec) continue;
    adjustments.push({
      receiver: recipient.address,
      fromRateWeiPerSec: rate,
      toRateWeiPerSec: recipient.committedRateWeiPerSec,
      reason: "restore-to-committed",
    });
  }

  if (adjustments.length === 0) return hold;
  return { kind: "restore", runwaySec, breach: false, adjustments, escalation: null };
}

export function decide(facts: Facts, policy: Policy): Decision {
  const ordered = shedOrder(facts, policy);
  const listedOutflow = ordered.reduce((sum, e) => sum + e.rate, 0n);
  const netOutflow = listedOutflow + facts.unlistedOutflowWeiPerSec;

  if (netOutflow === 0n) {
    return considerRestore(facts, policy, null);
  }

  const runwaySec = facts.availableBalanceWei / netOutflow;
  if (runwaySec >= policy.minRunwaySec) {
    return considerRestore(facts, policy, runwaySec);
  }

  const budget = facts.availableBalanceWei / policy.targetRunwaySec;
  let need = netOutflow - budget;
  const adjustments: Adjustment[] = [];

  for (const { recipient, rate } of ordered) {
    if (need <= 0n) break;
    const reducible = rate > recipient.floorRateWeiPerSec ? rate - recipient.floorRateWeiPerSec : 0n;
    if (reducible === 0n) continue;
    const take = reducible < need ? reducible : need;
    // `rate` is read straight from the chain and can exceed
    // `committedRateWeiPerSec`: the treasury keeps its own keys and can raise
    // a stream by hand at any time, and `committedRateWeiPerSec` is
    // hand-edited policy YAML that can be lowered beneath a live rate.
    // Invariant 2 (`toRate <= committedRate`) holds regardless, so a partial
    // shed that would otherwise leave the stream above its committed rate is
    // clamped down to it instead — never below, since every floor is already
    // at or under its own committed rate.
    const uncappedToRate = rate - take;
    const toRateWeiPerSec =
      uncappedToRate > recipient.committedRateWeiPerSec ? recipient.committedRateWeiPerSec : uncappedToRate;
    adjustments.push({
      receiver: recipient.address,
      fromRateWeiPerSec: rate,
      toRateWeiPerSec,
      reason: "budget-shed",
    });
    // The actual reduction achieved can exceed the planned `take` when the
    // clamp above bites; charge `need` for what really happened; not doing so
    // would under-count how much budget the clamp already recovered and shed
    // more than necessary from the next stream in line.
    need -= rate - toRateWeiPerSec;
  }

  const escalation: Escalation | null =
    need > 0n
      ? {
          kind: "floors-exceed-budget",
          detail: `${need} wei/sec above budget after every floor was reached`,
        }
      : null;

  return { kind: "reduce", runwaySec, breach: true, adjustments, escalation };
}
