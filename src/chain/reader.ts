import { CFA_FORWARDER_ADDRESS, CFA_FORWARDER_READ_ABI, SUPER_TOKEN_READ_ABI } from "./abi.js";
import type { Facts, Policy, Stream } from "../policy/types.js";
import { reason, redact } from "../redact.js";

export type ReadFailure = { what: string; reason: string };

export class ReadIncompleteError extends Error {
  readonly failures: readonly ReadFailure[];
  constructor(failures: ReadFailure[]) {
    super(
      [
        `${failures.length} chain read(s) failed; no decision was taken.`,
        ...failures.map((f) => `  - ${f.what}: ${f.reason}`),
      ].join("\n"),
    );
    this.name = "ReadIncompleteError";
    this.failures = failures;
  }
}

export type PublicClientLike = {
  readContract: (args: {
    address: string;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
    /**
     * Pins the read to one block. `readFacts` sets it on every call so the
     * facts describe a single state of the chain rather than a smear across
     * whatever blocks landed while it was reading.
     */
    blockNumber?: bigint;
  }) => Promise<unknown>;
  /**
   * Optional so every existing test double keeps compiling: a client that
   * cannot report a height simply reads unpinned, exactly as before.
   */
  getBlockNumber?: () => Promise<bigint>;
};

export type ReaderDeps = {
  client: PublicClientLike;
  /**
   * The RPC endpoint URL, kept here solely so a failed read can redact it out
   * of the error text before it becomes a `ReadFailure.reason`. A hosted
   * provider (Alchemy, Infura, ...) embeds its API key in the URL path
   * itself, which survives into a thrown `HttpRequestError`'s message --
   * viem's own credential stripping only handles basic-auth. Optional so
   * every existing test double that has no secret to redact keeps compiling
   * unchanged, and accepts a list so a quorum client's several endpoints are
   * all stripped, not just the first.
   */
  rpcUrl?: string | readonly string[];
};

/**
 * Reads the treasury's balance, its locked deposit and each policy
 * recipient's flow rate straight from the chain. Fails closed: if any single
 * read fails, no facts are returned at all and no decision is taken on a
 * partial view of the chain.
 */
export async function readFacts(
  deps: ReaderDeps,
  policy: Policy,
  nowSec: number,
): Promise<Facts> {
  const failures: ReadFailure[] = [];
  // Every `ReadFailure.reason` goes through this, not `reason(error)` alone:
  // a hosted RPC provider's key travels in the URL path, not basic-auth, so
  // it survives into a thrown HttpRequestError's message otherwise.
  const secrets = deps.rpcUrl === undefined ? [] : [deps.rpcUrl].flat();
  const safeReason = (error: unknown) => redact(reason(error), secrets);

  // The facts are five separate reads. Unpinned, a block can land between the
  // balance and the last stream, and the tick would divide a balance from one
  // block by an outflow from another -- each read true, the pair not. It also
  // matters for a quorum client: two endpoints at different heights would
  // disagree on a rate that never changed, and fail the tick for nothing.
  let blockNumber: bigint | undefined;
  if (deps.client.getBlockNumber) {
    blockNumber = await deps.client.getBlockNumber().catch((error: unknown) => {
      failures.push({ what: "getBlockNumber", reason: safeReason(error) });
      return undefined;
    });
    if (blockNumber === undefined) throw new ReadIncompleteError(failures);
  }

  const balanceResult = await deps.client
    .readContract({
      blockNumber,
      address: policy.token,
      abi: SUPER_TOKEN_READ_ABI,
      functionName: "realtimeBalanceOf",
      args: [policy.sender, BigInt(nowSec)],
    })
    .catch((error: unknown) => {
      failures.push({ what: "realtimeBalanceOf", reason: safeReason(error) });
      return null;
    });

  const accountFlowrateResult = await deps.client
    .readContract({
      blockNumber,
      address: CFA_FORWARDER_ADDRESS,
      abi: CFA_FORWARDER_READ_ABI,
      functionName: "getAccountFlowrate",
      args: [policy.token, policy.sender],
    })
    .catch((error: unknown) => {
      failures.push({ what: "getAccountFlowrate", reason: safeReason(error) });
      return null;
    });

  const streams: Stream[] = [];
  // Sequential rather than Promise.all: eight recipients is the realistic
  // upper bound here, and a serial loop keeps well inside any public RPC's
  // rate limit without a batching layer that would have to be tested too.
  for (const recipient of policy.recipients) {
    const flow = await deps.client
      .readContract({
        blockNumber,
        address: CFA_FORWARDER_ADDRESS,
        abi: CFA_FORWARDER_READ_ABI,
        functionName: "getFlowInfo",
        args: [policy.token, policy.sender, recipient.address],
      })
      .catch((error: unknown) => {
        failures.push({ what: `getFlowInfo(${recipient.address})`, reason: safeReason(error) });
        return null;
      });
    if (flow !== null) {
      const [, flowRate] = flow as readonly [bigint, bigint, bigint, bigint];
      streams.push({ receiver: recipient.address, flowRateWeiPerSec: flowRate });
    }
  }

  if (failures.length > 0) throw new ReadIncompleteError(failures);

  const [available, deposit] = balanceResult as readonly [bigint, bigint, bigint];
  const accountFlowrate = accountFlowrateResult as bigint;

  // getAccountFlowrate is negative for a net sender. Listed streams are the
  // ones the policy named; whatever drains beyond them is unlisted.
  const totalOutflow = accountFlowrate < 0n ? -accountFlowrate : 0n;
  const listedOutflow = streams.reduce((sum, s) => sum + s.flowRateWeiPerSec, 0n);
  // The clamp matters: an account that receives more than it sends has a
  // positive net rate, and a treasury whose listed streams exceed the
  // measured total (possible for one block around an update) must not
  // produce a negative field.
  const unlistedOutflowWeiPerSec =
    totalOutflow > listedOutflow ? totalOutflow - listedOutflow : 0n;

  return {
    nowSec,
    // A negative available balance means the account is already insolvent.
    // Clamped to zero so runway arithmetic stays in the non-negative domain
    // rather than producing a negative runway that reads as "plenty of time".
    availableBalanceWei: available < 0n ? 0n : available,
    depositWei: deposit,
    streams,
    unlistedOutflowWeiPerSec,
  };
}
