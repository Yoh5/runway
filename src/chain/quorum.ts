import type { PublicClientLike } from "./reader.js";

/**
 * Raised when two RPC endpoints answer the same read differently. This is a
 * read failure, not a tie to be broken: `readFacts` turns any throw into a
 * `ReadIncompleteError`, so the tick ends with no decision taken — which is
 * the correct outcome when the chain's own replicas do not agree on what the
 * chain says.
 */
export class RpcDisagreementError extends Error {
  constructor(functionName: string, values: string[]) {
    super(
      `RPC endpoints disagree on ${functionName}: ${values.join(" vs ")}. No decision is taken on a contested read.`,
    );
    this.name = "RpcDisagreementError";
  }
}

/** Canonical form for comparison, since a read can answer a tuple of bigints. */
function canonical(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, v]) => `${key}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * Reads the same call from several RPC endpoints and only answers when they
 * agree.
 *
 * One endpoint once answered "not found" for a transaction the others had —
 * a replica running behind, which announces itself in no way at all. A keeper
 * that believes the first answer it receives can throttle someone's pay on a
 * stale view of the chain, and the write that follows is perfectly valid and
 * perfectly wrong.
 *
 * So: a failing endpoint is tolerated (the healthy ones answer), and a
 * disagreeing one is not (nobody answers). Two against one is still a
 * disagreement — replicas lag in groups, and a flow rate is not a vote.
 *
 * With a single endpoint configured this is a pass-through, making exactly
 * one call, so nothing changes for a deployment that has only one URL.
 */
export function createQuorumClient(clients: readonly PublicClientLike[]): PublicClientLike {
  if (clients.length === 0) {
    throw new Error("createQuorumClient needs at least one client");
  }
  const [only] = clients;
  if (clients.length === 1 && only) return only;

  return {
    readContract: async (args) => {
      const settled = await Promise.allSettled(clients.map((client) => client.readContract(args)));

      const answers = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
      if (answers.length === 0) {
        const first = settled[0];
        const detail = first && first.status === "rejected" ? `: ${String(first.reason)}` : "";
        throw new Error(`all ${clients.length} RPC endpoints failed${detail}`);
      }

      const distinct = [...new Set(answers.map(canonical))];
      if (distinct.length > 1) {
        throw new RpcDisagreementError(args.functionName, distinct);
      }
      return answers[0];
    },
  };
}
