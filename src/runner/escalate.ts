import type { RunEscalation } from "./record.js";

export type NotifyFn = (webhook: string, payload: unknown) => Promise<void>;

/**
 * Posts one escalation to the policy's webhook and reports truthfully whether
 * the post itself succeeded. `detail` always describes the escalation itself,
 * unchanged by the outcome of the delivery attempt. A webhook that throws
 * does not lose the escalation: the run record still carries it, with
 * `delivered: false` — the one outcome this design refuses is a silent
 * breach, where a treasury drifts unattended because nobody was told.
 */
export async function deliverEscalation(
  notify: NotifyFn,
  webhook: string,
  kind: string,
  detail: string,
): Promise<RunEscalation> {
  try {
    await notify(webhook, { kind, detail });
    return { kind, detail, delivered: true };
  } catch {
    return { kind, detail, delivered: false };
  }
}
