import type { ExecutionOutcome } from "../keeperhub/execute.js";
import type { Adjustment, Decision, Facts } from "../policy/types.js";
import type { RunEscalation, RunRecord } from "../runner/record.js";
import { escapeHtml, pageShell } from "./template.js";

/**
 * Renders a non-negative number of seconds as a `Xd Xh Xm Xs` duration,
 * dropping leading zero components. `null` — `decide` returns this when
 * every listed and unlisted stream is at zero, so there is no rate to divide
 * the balance by — reads as "n/a" rather than a fabricated number.
 */
function formatRunway(runwaySec: bigint | null): string {
  if (runwaySec === null) return "n/a";
  const negative = runwaySec < 0n;
  let remainder = negative ? -runwaySec : runwaySec;
  const days = remainder / 86_400n;
  remainder %= 86_400n;
  const hours = remainder / 3_600n;
  remainder %= 3_600n;
  const minutes = remainder / 60n;
  const seconds = remainder % 60n;

  const parts: string[] = [];
  if (days > 0n) parts.push(`${days}d`);
  if (days > 0n || hours > 0n) parts.push(`${hours}h`);
  if (days > 0n || hours > 0n || minutes > 0n) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return (negative ? "-" : "") + parts.join(" ");
}

function decisionBadge(decision: Decision | null): string {
  if (!decision) {
    return `<span class="badge badge-unknown">no decision — chain read failed</span>`;
  }
  const kindClass =
    decision.kind === "hold" ? "badge-hold" : decision.kind === "restore" ? "badge-restore" : "badge-reduce";
  const breach = decision.breach ? ` <span class="badge badge-breach">breach</span>` : "";
  return `<span class="badge ${kindClass}">${escapeHtml(decision.kind)}</span>${breach}`;
}

function renderStreamsTable(facts: Facts | null, decision: Decision | null): string {
  if (!facts) {
    return `<p class="muted">No chain read for this run — streams unknown.</p>`;
  }
  if (facts.streams.length === 0) {
    return `<p class="muted">No listed streams.</p>`;
  }
  const adjustmentByReceiver = new Map((decision?.adjustments ?? []).map((a) => [a.receiver, a]));
  const rows = facts.streams
    .map((stream) => {
      const adjustment = adjustmentByReceiver.get(stream.receiver);
      const change = adjustment
        ? `<td>${escapeHtml(adjustment.fromRateWeiPerSec.toString())} &rarr; ${escapeHtml(
            adjustment.toRateWeiPerSec.toString(),
          )} <span class="muted">(${escapeHtml(adjustment.reason)})</span></td>`
        : `<td class="muted">unchanged</td>`;
      return `<tr><td class="mono">${escapeHtml(stream.receiver)}</td><td>${escapeHtml(
        stream.flowRateWeiPerSec.toString(),
      )} wei/sec</td>${change}</tr>`;
    })
    .join("");
  return `<table>
  <thead><tr><th>Receiver</th><th>Rate this run</th><th>Adjustment</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderOutcomeRow(entry: { adjustment: Adjustment; outcome: ExecutionOutcome }): string {
  const { adjustment, outcome } = entry;
  const receiver = `<td class="mono">${escapeHtml(adjustment.receiver)}</td>`;

  if (outcome.status === "landed") {
    return `<tr>${receiver}<td class="status-landed">landed</td><td><a href="${escapeHtml(
      outcome.transactionLink,
    )}">${escapeHtml(outcome.transactionHash)}</a></td><td>${escapeHtml(outcome.gasUsedWei)} wei gas${
      outcome.sponsored ? ' <span class="muted">(sponsored)</span>' : ""
    }</td></tr>`;
  }

  if (outcome.status === "refused") {
    return `<tr>${receiver}<td class="status-refused">refused (${escapeHtml(
      outcome.stage,
    )})</td><td colspan="2">${escapeHtml(outcome.detail)}</td></tr>`;
  }

  return `<tr>${receiver}<td class="status-unresolved">unresolved</td><td colspan="2">${escapeHtml(
    outcome.detail,
  )}</td></tr>`;
}

function renderOutcomes(outcomes: { adjustment: Adjustment; outcome: ExecutionOutcome }[]): string {
  if (outcomes.length === 0) {
    return `<p><strong>No action taken this run.</strong></p>`;
  }
  const rows = outcomes.map(renderOutcomeRow).join("");
  return `<table>
  <thead><tr><th>Receiver</th><th>Status</th><th colspan="2">Result</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderEscalations(escalations: RunEscalation[]): string {
  if (escalations.length === 0) return "";
  const items = escalations
    .map(
      (e) =>
        `<li><span class="${e.delivered ? "muted" : "status-refused"}">${
          e.delivered ? "delivered" : "FAILED TO DELIVER"
        }</span> — ${escapeHtml(e.kind)}: ${escapeHtml(e.detail)}</li>`,
    )
    .join("");
  return `<h3>Escalations</h3><ul>${items}</ul>`;
}

function renderRun(record: RunRecord): string {
  const runwayLine = record.decision
    ? `<div class="summary-item"><span class="label">Runway</span><span class="value">${escapeHtml(
        formatRunway(record.decision.runwaySec),
      )}</span></div>`
    : "";

  return `<section class="run">
  <h3>${escapeHtml(record.startedAt)}</h3>
  <div class="summary-grid">
    <div class="summary-item"><span class="label">Decision</span><span class="value">${decisionBadge(
      record.decision,
    )}</span></div>
    ${runwayLine}
  </div>
  ${renderStreamsTable(record.facts, record.decision)}
  ${renderOutcomes(record.outcomes)}
  ${renderEscalations(record.escalations)}
</section>`;
}

/**
 * Renders every run record into one self-contained HTML document: no
 * `<script>`, no `<link>`, no remote `src` — a judge opens the file with no
 * network and it renders. Contains no policy of its own: this only formats
 * what a `RunRecord` already carries, and never decides anything itself.
 */
export function renderReport(records: RunRecord[]): string {
  if (records.length === 0) {
    return pageShell("Runway report", `<h1>Runway report</h1><p class="muted">No runs recorded yet.</p>`);
  }

  // Most recent first, by `startedAt` (ISO 8601 sorts lexically), regardless
  // of the order the caller happened to pass records in.
  const sorted = [...records].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const latest = sorted[0] as RunRecord;

  const latestRunway = latest.decision ? formatRunway(latest.decision.runwaySec) : "n/a";
  const summary = `<div class="summary-grid">
    <div class="summary-item"><span class="label">Latest run</span><span class="value">${escapeHtml(
      latest.startedAt,
    )}</span></div>
    <div class="summary-item"><span class="label">Runway</span><span class="value">${escapeHtml(
      latestRunway,
    )}</span></div>
    <div class="summary-item"><span class="label">Decision</span><span class="value">${decisionBadge(
      latest.decision,
    )}</span></div>
  </div>`;

  const history = sorted.map(renderRun).join("\n");

  return pageShell(
    "Runway report",
    `<h1>Runway report</h1>
${summary}
<h2>Run history (most recent first)</h2>
${history}`,
  );
}
