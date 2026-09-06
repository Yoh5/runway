import type { Adjustment, Decision, Facts } from "../policy/types.js";
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
