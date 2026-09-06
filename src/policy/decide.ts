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

export function decide(facts: Facts, policy: Policy): Decision {
  const ordered = shedOrder(facts, policy);
  const netOutflow = ordered.reduce((sum, e) => sum + e.rate, 0n);

  if (netOutflow === 0n) {
    return { kind: "hold", runwaySec: null, breach: false, adjustments: [], escalation: null };
  }

  const runwaySec = facts.availableBalanceWei / netOutflow;
  if (runwaySec >= policy.minRunwaySec) {
    return { kind: "hold", runwaySec, breach: false, adjustments: [], escalation: null };
  }

  const budget = facts.availableBalanceWei / policy.targetRunwaySec;
  let need = netOutflow - budget;
  const adjustments: Adjustment[] = [];

  for (const { recipient, rate } of ordered) {
    if (need <= 0n) break;
    const reducible = rate > recipient.floorRateWeiPerSec ? rate - recipient.floorRateWeiPerSec : 0n;
    if (reducible === 0n) continue;
    const take = reducible < need ? reducible : need;
    adjustments.push({
      receiver: recipient.address,
      fromRateWeiPerSec: rate,
      toRateWeiPerSec: rate - take,
      reason: "budget-shed",
    });
    need -= take;
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
