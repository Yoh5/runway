import { idempotencyKey } from "./idempotency.js";
import type { Address, Adjustment, Policy } from "../policy/types.js";

/**
 * Result of a local dry run against our own RPC. KeeperHub's own `simulate`
 * body flag is NOT sent over the wire: the catch-all protocol route
 * (`/api/execute/[...slug]`) never reads it, so an unrecognised field is
 * silently ignored rather than refused — sending it would broadcast a real
 * transaction while looking like a dry run, and the real broadcast that
 * followed would then send a second one. `deps.simulate` instead wraps a
 * viem `simulateContract` call against `CFA_FORWARDER_ADDRESS.updateFlow`,
 * with `account` set to the KeeperHub Turnkey EOA, run entirely locally.
 */
export type SimulateResult = { reverted: false } | { reverted: true; reason: string };

export type SimulateFn = (args: {
  token: Address;
  sender: Address;
  receiver: Address;
  flowRateWeiPerSec: bigint;
}) => Promise<SimulateResult>;

export type ExecutorDeps = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  simulate: SimulateFn;
  /**
   * Total time budget, in milliseconds, for retrying a broadcast that
   * KeeperHub answers with a 409 `idempotency_in_progress`. This is not a
   * status poll: KeeperHub's protocol-action route is synchronous and its
   * response is terminal (no `executionId`, nothing to poll). The only
   * reason to call the endpoint again is that our own prior attempt is
   * still being processed under the same key.
   */
  pollBudgetMs: number;
  /** Injected so a retry-budget test runs instantly instead of on a real timer. */
  sleep: (ms: number) => Promise<void>;
};

export type ExecutionOutcome =
  | {
      status: "landed";
      transactionHash: string;
      transactionLink: string;
      gasUsedWei: string;
      effectiveGasPriceWei: string;
      /**
       * true means a relayer submitted the transaction: an explorer will show
       * a sender that is not our wallet and a value of 0. Recorded beside the
       * hash so a run record does not look wrong to anyone who checks it.
       */
      sponsored: boolean;
    }
  | { status: "refused"; stage: "simulate" | "broadcast"; detail: string }
  | { status: "unresolved"; detail: string };

const RETRY_INTERVAL_MS = 500;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strips the API key out of any text before it can reach an outcome. The key
 * is never logged, never included in an error message, and never written to
 * a run record — including when it leaks into a message we did not write
 * ourselves, such as a network client embedding the failed request's headers
 * in its own thrown error.
 */
function redactKey(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[redacted]") : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Posts one already-decided adjustment to KeeperHub's direct-execution API
 * and reports truthfully whether it landed. Contains no policy: it cannot
 * skip, reorder or alter the adjustment it is given, and never logs or
 * returns the API key.
 */
export async function executeAdjustment(
  deps: ExecutorDeps,
  policy: Policy,
  adjustment: Adjustment,
  nowSec: number,
): Promise<ExecutionOutcome> {
  const body = {
    chainId: policy.chainId,
    token: policy.token,
    sender: policy.sender,
    receiver: adjustment.receiver,
    flowRate: adjustment.toRateWeiPerSec.toString(),
    userData: "0x",
  };

  const simulation = await deps.simulate({
    token: policy.token,
    sender: policy.sender,
    receiver: adjustment.receiver,
    flowRateWeiPerSec: adjustment.toRateWeiPerSec,
  });
  if (simulation.reverted) {
    return { status: "refused", stage: "simulate", detail: redactKey(simulation.reason, deps.apiKey) };
  }

  const key = idempotencyKey(policy, adjustment, nowSec);
  let elapsedMs = 0;

  for (;;) {
    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}/api/execute/superfluid/update-flow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        status: "unresolved",
        detail: redactKey(`broadcast request failed: ${reason(error)}`, deps.apiKey),
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      return {
        status: "unresolved",
        detail: redactKey(
          `broadcast response (http ${response.status}) was not valid JSON: ${reason(error)}`,
          deps.apiKey,
        ),
      };
    }
    const data = isRecord(parsed) ? parsed : {};

    if (response.status === 409 && data.code === "idempotency_in_progress" && data.retryable === true) {
      if (elapsedMs >= deps.pollBudgetMs) {
        return {
          status: "unresolved",
          detail: "broadcast was still in progress when the retry budget ran out",
        };
      }
      await deps.sleep(RETRY_INTERVAL_MS);
      elapsedMs += RETRY_INTERVAL_MS;
      continue;
    }

    if (response.status === 409 && data.code === "idempotency_conflict") {
      const original = typeof data.originalExecutionId === "string" ? data.originalExecutionId : "unknown";
      return {
        status: "refused",
        stage: "broadcast",
        detail: `idempotency key already resolved a different broadcast (original execution: ${original}); rotating the key here could double-send`,
      };
    }

    if (data.success === true && typeof data.transactionHash === "string") {
      return {
        status: "landed",
        transactionHash: data.transactionHash,
        transactionLink: typeof data.transactionLink === "string" ? data.transactionLink : "",
        gasUsedWei: typeof data.gasUsed === "string" ? data.gasUsed : String(data.gasUsed ?? ""),
        effectiveGasPriceWei:
          typeof data.effectiveGasPrice === "string" ? data.effectiveGasPrice : String(data.effectiveGasPrice ?? ""),
        sponsored: data.sponsored === true,
      };
    }

    if (data.success === false) {
      const parts = [typeof data.error === "string" ? data.error : "broadcast refused"];
      if (typeof data.rejection === "string") parts.push(data.rejection);
      return { status: "refused", stage: "broadcast", detail: redactKey(parts.join(": "), deps.apiKey) };
    }

    // A 4xx status (other than the two 409 codes already handled above) means
    // KeeperHub rejected the request before it could broadcast anything --
    // an invalid or under-scoped key, a malformed body -- even if the error
    // body does not carry a `success` field. That is a known refusal, not an
    // unknown outcome.
    if (response.status >= 400 && response.status < 500 && typeof data.error === "string") {
      return { status: "refused", stage: "broadcast", detail: redactKey(data.error, deps.apiKey) };
    }

    return {
      status: "unresolved",
      detail: `unrecognised broadcast response (http ${response.status})`,
    };
  }
}
