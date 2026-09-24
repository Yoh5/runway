import { UNRESOLVED_WEBHOOK_PREFIX } from "../policy/types.js";
import type { NotifyFn } from "./escalate.js";

/**
 * Hosts that cannot receive an escalation. `example.invalid` is what the
 * policy template ships with, and the run of 8 September 2026 escalated into
 * it: the decision was right, the report said `delivered: false`, and nobody
 * was told. Anything unparseable counts as a placeholder too — this guard
 * exists to refuse a silent breach, so an ambiguous URL fails the same way a
 * missing one does.
 */
const RESERVED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "invalid"]);
const RESERVED_SUFFIXES = [".invalid", ".example.com", ".example.net", ".example.org", ".test"];
const RESERVED_EXACT = ["example.com", "example.net", "example.org"];

export function isPlaceholderWebhook(webhook: string): boolean {
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase();
  if (RESERVED_HOSTS.has(host)) return true;
  if (RESERVED_EXACT.includes(host)) return true;
  return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Called on every path that can move a rate — the CLI's write mode and the
 * HTTP tick — before a single read. A tick that can throttle someone's pay
 * must be able to tell a human when it stops, and the 8 September 2026 run is
 * the proof: it decided correctly, escalated, and the escalation went to
 * `example.invalid`. Dry runs escalate to nobody, so they skip this.
 */
export function assertDeliverableEscalation(webhook: string): void {
  if (webhook.startsWith(UNRESOLVED_WEBHOOK_PREFIX)) {
    const name = webhook.slice(UNRESOLVED_WEBHOOK_PREFIX.length);
    throw new Error(`escalation.webhook is unresolved: ${name} is not set in the environment`);
  }
  if (isPlaceholderWebhook(webhook)) {
    throw new Error(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} form is the policy syntax this message tells the operator to use
      "escalation.webhook is a placeholder; set a real endpoint (or ${ESCALATION_WEBHOOK}) before running in write mode",
    );
  }
}

export type NotifierDeps = {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  /** Total attempts, not retries: 1 means post once and give up. */
  attempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
};

/**
 * A retry is only worth making when the failure might not repeat: a socket
 * error, a 429, or a 5xx. A 4xx is the endpoint telling us the request itself
 * is wrong — a wrong URL or a revoked token does not heal between two posts,
 * and retrying only delays the run from recording the truth.
 */
function worthRetrying(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The two endpoints a treasury actually points this at reject the escalation
 * as it stands: Discord wants `content`, Slack wants `text`, and both answer
 * a bare `{kind, detail}` with a 400 — which is not retried, so the run would
 * record `delivered: false` for a webhook that was perfectly reachable.
 * Anything else receives the escalation unchanged, because a receiver written
 * for this keeper wants the fields, not a sentence.
 */
function bodyFor(webhook: string, payload: unknown): unknown {
  const { kind, detail } = (payload ?? {}) as { kind?: string; detail?: string };
  if (kind === undefined) return payload;
  const line = `Runway escalation — ${kind}: ${detail ?? ""}`.trim();

  let host: string;
  try {
    host = new URL(webhook).hostname.toLowerCase();
  } catch {
    return payload;
  }
  if (host === "discord.com" || host.endsWith(".discord.com") || host.endsWith("discordapp.com")) {
    return { content: line };
  }
  if (host === "hooks.slack.com") {
    return { text: line };
  }
  return payload;
}

/**
 * Builds the escalation notifier: one POST of `{kind, detail}`, retried with
 * a widening delay, under a hard timeout so an endpoint that accepts the
 * connection and then never answers cannot hold a tick open forever.
 *
 * Delivery is at-least-once by design. A webhook that receives the same
 * escalation twice has told a human twice; one that receives it zero times is
 * the failure this whole path exists to prevent. Escalations carry no money
 * and no idempotency key for that reason.
 *
 * Throwing on exhaustion is deliberate: `deliverEscalation` turns it into
 * `delivered: false` on the record, which is what the report prints.
 */
export function createWebhookNotifier(deps: NotifierDeps): NotifyFn {
  const attempts = deps.attempts ?? 3;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const baseDelayMs = deps.baseDelayMs ?? 500;

  return async function notify(webhook: string, payload: unknown): Promise<void> {
    let lastError: Error = new Error("escalation webhook was never attempted");

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await deps.fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyFor(webhook, payload)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return;
        lastError = new Error(`escalation webhook responded with http ${response.status}`);
        if (!worthRetrying(response.status)) throw lastError;
      } catch (error) {
        const thrown = error instanceof Error ? error : new Error(String(error));
        // A non-retryable status was rethrown above; surface it unchanged
        // rather than burning the remaining attempts on it.
        if (thrown === lastError) throw thrown;
        lastError = thrown;
      }

      if (attempt < attempts) await deps.sleep(baseDelayMs * 2 ** (attempt - 1));
    }

    throw lastError;
  };
}
