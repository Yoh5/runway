import { describe, expect, it } from "vitest";
import { createQuorumClient, RpcDisagreementError } from "../../src/chain/quorum.js";
import type { PublicClientLike } from "../../src/chain/reader.js";

const CALL = {
  address: "0xcfA132E353cB4E398080B9700609bb008eceB125",
  abi: [],
  functionName: "getFlowInfo",
  args: [],
} as const;

/** A node that answers with `value`, or throws `value` when it is an Error. */
function node(value: unknown, calls: { n: number } = { n: 0 }): PublicClientLike {
  return {
    readContract: async () => {
      calls.n += 1;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("createQuorumClient -- a single node", () => {
  it("passes the answer straight through, with no extra call", async () => {
    const calls = { n: 0 };
    const client = createQuorumClient([node(42n, calls)]);

    await expect(client.readContract({ ...CALL })).resolves.toBe(42n);
    expect(calls.n).toBe(1);
  });

  it("propagates its failure, because there is nothing to fall back to", async () => {
    const client = createQuorumClient([node(new Error("rpc 503"))]);
    await expect(client.readContract({ ...CALL })).rejects.toThrow(/rpc 503/);
  });
});

describe("createQuorumClient -- several nodes that agree", () => {
  it("returns the answer they agree on", async () => {
    const client = createQuorumClient([node(86_791_147_994n), node(86_791_147_994n)]);
    await expect(client.readContract({ ...CALL })).resolves.toBe(86_791_147_994n);
  });

  it("agrees on structured answers too, not just scalars", async () => {
    const tuple = [1n, 86_791_147_994n, 0n];
    const client = createQuorumClient([node([...tuple]), node([...tuple])]);
    await expect(client.readContract({ ...CALL })).resolves.toEqual(tuple);
  });

  it("answers from the healthy nodes when one is down", async () => {
    const client = createQuorumClient([
      node(new Error("socket hang up")),
      node(86_791_147_994n),
      node(86_791_147_994n),
    ]);
    await expect(client.readContract({ ...CALL })).resolves.toBe(86_791_147_994n);
  });
});

describe("createQuorumClient -- nodes that disagree", () => {
  /**
   * The incident this exists for: one node once answered "not found" for a
   * transaction the others had. A replica running behind does not announce
   * itself, so a keeper that believes the first answer it gets can throttle
   * a stream on a stale view of the chain.
   */
  it("refuses to pick a winner, and says which values it saw", async () => {
    const client = createQuorumClient([node(86_791_147_994n), node(0n)]);

    const call = client.readContract({ ...CALL });
    await expect(call).rejects.toThrow(RpcDisagreementError);
    await expect(call).rejects.toThrow(/86791147994/);
    await expect(call).rejects.toThrow(/getFlowInfo/);
  });

  it("fails closed rather than falling back to a majority", async () => {
    // Two against one is still a disagreement: a majority of replicas can lag
    // together, and a rate is not a vote.
    const client = createQuorumClient([node(5n), node(5n), node(7n)]);
    await expect(client.readContract({ ...CALL })).rejects.toThrow(RpcDisagreementError);
  });
});

describe("createQuorumClient -- every node down", () => {
  it("reports how many failed and carries one reason, so the tick fails closed", async () => {
    const client = createQuorumClient([
      node(new Error("socket hang up")),
      node(new Error("rpc 503")),
    ]);
    await expect(client.readContract({ ...CALL })).rejects.toThrow(/2 .*(node|endpoint)/i);
  });
});

describe("createQuorumClient -- construction", () => {
  it("refuses an empty list rather than silently reading nothing", () => {
    expect(() => createQuorumClient([])).toThrow();
  });
});
