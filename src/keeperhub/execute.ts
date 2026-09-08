import { idempotencyKey } from "./idempotency.js";
import type { Address, Adjustment, Policy } from "../policy/types.js";
import { reason, redact } from "../redact.js";

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
  /**
   * The RPC endpoint URL `simulate` (a local viem client, built in cli.ts)
   * reads against. Carried here purely for redaction: `simulate`'s own
   * thrown errors can embed a hosted provider's key baked into the URL path,
   * and that text flows into this module's outcomes (`stage: "simulate"`)
   * exactly like any other failure reason. Optional so existing test doubles
   * with no such secret keep compiling unchanged.
   */
  rpcUrl?: string;
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

/**
 * Which KeeperHub response contract this outcome was actually mapped from.
 * `"success"` is the boolean-`success` shape the route answered with when
 * this executor was first written; `"status"` is the explicit
 * `"completed" | "failed" | "unconfirmed"` state KeeperHub's `staging`
 * branch switched to (`app/api/execute/[...slug]/route.ts`), dropping
 * `success` entirely. We do not know whether the live deployment has caught
 * up with `staging`, so both are handled and this field states -- on every
 * outcome either branch produces -- which one actually answered, rather
 * than leaving a reader to infer it from the field's absence. If the two
 * ever diverge again, this is what tells a reader when.
 *
 * Not stamped on the handful of outcomes produced before or without ever
 * seeing a body that could carry either field: a local `simulate` revert
 * (no HTTP call made at all), a `fetch` throw (no response received), an
 * unparseable body, or a 409 idempotency signal (KeeperHub's retry/conflict
 * codes, which answer independently of which response contract is live).
 * Those cases have nothing to name -- they didn't observe a contract, so
 * they don't claim one.
 */
export type ResponseContract = "status" | "success";

export type ExecutionOutcome =
  | {
      status: "landed";
      transactionHash: string;
      transactionLink: string;
      /**
       * Decimal wei strings, present only when the response actually
       * reported them. The old (`success`-boolean) contract always sends
       * both; KeeperHub's new (`status`-bearing) contract sends neither at
       * all -- so on that contract this is the common case, not an edge one.
       * Absent must read as "not reported", never coerced to `"0"`: `"0"` is
       * a specific, false claim ("this write cost nothing"), and BigInt("")
       * would silently produce exactly that for anyone computing gas paid
       * from an unguarded default. Optional for the same reason `sponsored`
       * is -- so every consumer (the report renderer, the evidence document
       * and its test) has to decide what "not reported" looks like instead
       * of being handed a fabricated number.
       */
      gasUsedWei?: string;
      effectiveGasPriceWei?: string;
      /**
       * true means a relayer submitted the transaction: an explorer will show
       * a sender that is not our wallet and a value of 0. Recorded beside the
       * hash so a run record does not look wrong to anyone who checks it.
       *
       * Optional, and present only when the response body carried it. An
       * ordinary protocol-write response never includes this field at all --
       * it is set only on KeeperHub's Turnkey Gas Station path and on
       * sponsored failures -- so an absent field means "we were not told",
       * not "this was not sponsored". Coercing that to `false` would assert
       * the opposite of the truth to anyone checking the explorer.
       */
      sponsored?: boolean;
      /** See `ResponseContract`. */
      contract?: ResponseContract;
      /**
       * KeeperHub's execution id, present whenever the new contract's
       * response carried one. This is what makes
       * `GET /api/execute/{executionId}/status` reachable, and lets a human
       * reading a run record find the row on KeeperHub's side. The old
       * contract never sent one, so this stays absent there.
       */
      executionId?: string;
    }
  | {
      status: "refused";
      stage: "simulate" | "broadcast";
      detail: string;
      contract?: ResponseContract;
      executionId?: string;
    }
  | {
      status: "unresolved";
      detail: string;
      /**
       * Set when the broadcast response carried a `transactionHash` even
       * though the outcome could not be confirmed -- on the old contract,
       * that meant `success: false` with a hash anyway (KeeperHub's
       * `completeExecution` and `failExecution` can both report
       * `unconfirmed` this way when a hash re-verifies as landed on chain);
       * on the new contract, that is `status: "unconfirmed"` (with or
       * without a hash yet) or `status: "failed"` with a hash. Either way a
       * hash here means the outcome is genuinely unknown, not that nothing
       * happened. Carried as its own field (not just folded into `detail`'s
       * prose) so a later reader of a run record -- a human or the
       * reconciler that later settles the row KeeperHub completes
       * asynchronously -- can find and look up the hash without parsing
       * free text.
       */
      transactionHash?: string;
      contract?: ResponseContract;
      executionId?: string;
    };

const RETRY_INTERVAL_MS = 500;

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

  // Every outcome detail below goes through this before it is returned: the
  // KeeperHub API key and the RPC provider key `simulate` can embed in a
  // thrown error must never survive into a failure reason, an escalation
  // detail, or a serialised run record.
  const safeText = (text: string) => redact(text, [deps.apiKey, deps.rpcUrl]);

  const simulation = await deps.simulate({
    token: policy.token,
    sender: policy.sender,
    receiver: adjustment.receiver,
    flowRateWeiPerSec: adjustment.toRateWeiPerSec,
  });
  if (simulation.reverted) {
    return { status: "refused", stage: "simulate", detail: safeText(simulation.reason) };
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
        detail: safeText(`broadcast request failed: ${reason(error)}`),
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      return {
        status: "unresolved",
        detail: safeText(`broadcast response (http ${response.status}) was not valid JSON: ${reason(error)}`),
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
        detail: safeText(
          `idempotency key already resolved a different broadcast (original execution: ${original}); rotating the key here could double-send`,
        ),
      };
    }

    // New contract (KeeperHub `staging`, `app/api/execute/[...slug]/route.ts`):
    // the body carries a `status` field and never a `success` field. Checked
    // before the old-shape logic below so a `status`-bearing body never
    // falls into it -- `success` and `status` are mutually exclusive on the
    // two contracts, so this dispatch never has to guess between them.
    if (typeof data.status === "string") {
      const executionId = typeof data.executionId === "string" ? data.executionId : undefined;
      const hash = typeof data.transactionHash === "string" ? data.transactionHash : undefined;

      if (data.status === "completed" && hash !== undefined) {
        return {
          status: "landed",
          transactionHash: hash,
          transactionLink: typeof data.transactionLink === "string" ? data.transactionLink : "",
          // The new contract's response carries no gas figures at all (see
          // the type verified against `origin/staging`). Left absent rather
          // than defaulted to "" -- an empty string is a false "0" once a
          // consumer runs `BigInt` on it, and this contract not reporting
          // gas is the common case, not a one-off to paper over.
          contract: "status",
          ...(executionId ? { executionId } : {}),
        };
      }

      if (data.status === "unconfirmed") {
        // Poll-only, per KeeperHub's own comment on this response: the
        // transaction may still land. Reporting this as "refused" is exactly
        // the failure we reported to them -- a caller that treats any error
        // string as terminal would rotate the idempotency key and
        // double-broadcast a transaction that may still land. Never refused.
        return {
          status: "unresolved",
          contract: "status",
          ...(hash !== undefined ? { transactionHash: hash } : {}),
          ...(executionId ? { executionId } : {}),
          detail: safeText(
            `broadcast status "unconfirmed"${hash !== undefined ? ` (transactionHash ${hash})` : " (no transactionHash yet)"} -- this is poll-only, the write may still land, and it must never be treated as a refusal${executionId ? ` (executionId ${executionId})` : ""}`,
          ),
        };
      }

      if (data.status === "failed") {
        const parts = [typeof data.error === "string" ? data.error : "broadcast failed"];
        if (typeof data.rejection === "string") parts.push(data.rejection);
        if (typeof data.errorClass === "string") parts.push(data.errorClass);

        // A transaction hash on a "failed" status means a transaction still
        // reached the chain -- exactly the old contract's success: false
        // + hash case, just spelled with an explicit status now. Calling
        // this "refused" would tell the run record no money moved when it
        // may well have.
        if (hash !== undefined) {
          return {
            status: "unresolved",
            transactionHash: hash,
            contract: "status",
            ...(executionId ? { executionId } : {}),
            detail: safeText(
              `broadcast status "failed" but transactionHash ${hash} is present -- the write may be on chain despite the failure response: ${parts.join(": ")}`,
            ),
          };
        }

        return {
          status: "refused",
          stage: "broadcast",
          contract: "status",
          ...(executionId ? { executionId } : {}),
          detail: safeText(parts.join(": ")),
        };
      }

      // A `status` value outside the three KeeperHub documents (or
      // "completed" without a usable hash) is not a state this executor
      // knows how to act on. Unresolved, never landed -- guessing here is
      // exactly what would misreport an outcome against a contract we do
      // not fully recognise.
      return {
        status: "unresolved",
        contract: "status",
        ...(hash !== undefined ? { transactionHash: hash } : {}),
        ...(executionId ? { executionId } : {}),
        detail: safeText(`unrecognised status ${JSON.stringify(data.status)} in a new-contract broadcast response`),
      };
    }

    if (data.success === true && typeof data.transactionHash === "string") {
      return {
        status: "landed",
        transactionHash: data.transactionHash,
        transactionLink: typeof data.transactionLink === "string" ? data.transactionLink : "",
        // Spread in only when the response actually said so: an absent gas
        // figure must stay absent -- "not reported", not a false "0" once a
        // consumer runs BigInt on a defaulted "". The documented old
        // contract always sends both, but this stays a real string-or-absent
        // check rather than assuming that.
        ...(typeof data.gasUsed === "string" ? { gasUsedWei: data.gasUsed } : {}),
        ...(typeof data.effectiveGasPrice === "string" ? { effectiveGasPriceWei: data.effectiveGasPrice } : {}),
        // Same treatment: an absent field must stay absent, not become `false`.
        ...(typeof data.sponsored === "boolean" ? { sponsored: data.sponsored } : {}),
        contract: "success",
      };
    }

    if (data.success === false) {
      const parts = [typeof data.error === "string" ? data.error : "broadcast refused"];
      if (typeof data.rejection === "string") parts.push(data.rejection);

      // A transaction hash on a success: false body means a transaction
      // reached the chain: completeExecution and failExecution can both
      // report `unconfirmed` this way. Calling that "refused" would tell the
      // run record no money moved when it may well have -- with no
      // executionId in the body, this is the only chance to capture the hash
      // a human or the reconciler will need to look the row up later.
      if (typeof data.transactionHash === "string") {
        const hash = data.transactionHash;
        return {
          status: "unresolved",
          transactionHash: hash,
          contract: "success",
          detail: safeText(
            `broadcast reported success: false but transactionHash ${hash} is present -- the write may be on chain despite the failure response: ${parts.join(": ")}`,
          ),
        };
      }

      return { status: "refused", stage: "broadcast", contract: "success", detail: safeText(parts.join(": ")) };
    }

    // A 4xx status (other than the two 409 codes already handled above) means
    // KeeperHub rejected the request before it could broadcast anything --
    // an invalid or under-scoped key, a malformed body -- even if the error
    // body does not carry a `success` field. That is a known refusal, not an
    // unknown outcome. It predates the `status`-bearing contract too (no
    // `status` field here either), so it is tagged the same way: not the new
    // contract, the closest fit of the two named values.
    if (response.status >= 400 && response.status < 500 && typeof data.error === "string") {
      return { status: "refused", stage: "broadcast", contract: "success", detail: safeText(data.error) };
    }

    return {
      status: "unresolved",
      detail: `unrecognised broadcast response (http ${response.status})`,
    };
  }
}
