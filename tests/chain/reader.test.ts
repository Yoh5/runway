import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFacts, ReadIncompleteError } from "../../src/chain/reader.js";
import { CFA_FORWARDER_READ_ABI, SUPER_TOKEN_READ_ABI } from "../../src/chain/abi.js";
import type { Address, Policy } from "../../src/policy/types.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;

function policy(): Policy {
  return {
    version: 1, chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n, targetRunwaySec: 200n, hysteresisSec: 50n,
    recipients: [
      { address: A, label: "a", tier: "critical", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
      { address: B, label: "b", tier: "standard", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

function client(responses: Record<string, unknown>) {
  return {
    readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      const key = args.functionName === "realtimeBalanceOf"
        ? "balance"
        : args.functionName === "getAccountFlowrate"
          ? "accountFlowrate"
          : `flow:${String(args.args[2]).toLowerCase()}`;
      const value = responses[key];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected read: ${key}`);
      return value;
    },
  };
}

describe("readFacts", () => {
  it("returns available balance, deposit and one stream per policy recipient", async () => {
    const facts = await readFacts(
      { client: client({
          balance: [5000n, 400n, 0n],
          accountFlowrate: -100n,
          [`flow:${A}`]: [1_699_000_000n, 60n, 200n, 0n],
          [`flow:${B}`]: [1_699_000_000n, 40n, 200n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.availableBalanceWei).toBe(5000n);
    expect(facts.depositWei).toBe(400n);
    expect(facts.streams).toEqual([
      { receiver: A, flowRateWeiPerSec: 60n },
      { receiver: B, flowRateWeiPerSec: 40n },
    ]);
  });

  it("clamps a negative available balance to zero", async () => {
    const facts = await readFacts(
      { client: client({
          balance: [-1n, 400n, 0n],
          accountFlowrate: 0n,
          [`flow:${A}`]: [0n, 0n, 0n, 0n],
          [`flow:${B}`]: [0n, 0n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.availableBalanceWei).toBe(0n);
  });

  it("fails closed when any single read fails", async () => {
    await expect(
      readFacts(
        { client: client({
            balance: [5000n, 400n, 0n],
            accountFlowrate: -60n,
            [`flow:${A}`]: [0n, 60n, 0n, 0n],
            [`flow:${B}`]: new Error("RPC timeout"),
          }) },
        policy(),
        1_700_000_000,
      ),
    ).rejects.toBeInstanceOf(ReadIncompleteError);
  });

  it("names every failed read in the error", async () => {
    const error = await readFacts(
      { client: client({
          balance: new Error("RPC timeout"),
          accountFlowrate: 0n,
          [`flow:${A}`]: new Error("RPC timeout"),
          [`flow:${B}`]: [0n, 0n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    ).catch((e: unknown) => e as ReadIncompleteError);
    // readFacts's return type is Facts, so awaiting the .catch() above yields
    // a Facts | ReadIncompleteError union even though this scenario always
    // rejects; narrow it back before reading a field only the error has.
    expect((error as ReadIncompleteError).failures).toHaveLength(2);
  });

  it("reports zero unlisted outflow for a net receiver", async () => {
    // A positive account flowrate means the treasury is receiving on net;
    // there is no outflow at all, listed or otherwise.
    const facts = await readFacts(
      { client: client({
          balance: [5000n, 400n, 0n],
          accountFlowrate: 500n,
          [`flow:${A}`]: [0n, 10n, 0n, 0n],
          [`flow:${B}`]: [0n, 20n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.unlistedOutflowWeiPerSec).toBe(0n);
  });

  it("attributes drain beyond the listed streams to unlisted outflow", async () => {
    // Whole-account outflow is 300/sec; the policy only names 100/sec of it.
    const facts = await readFacts(
      { client: client({
          balance: [5000n, 400n, 0n],
          accountFlowrate: -300n,
          [`flow:${A}`]: [0n, 60n, 0n, 0n],
          [`flow:${B}`]: [0n, 40n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.unlistedOutflowWeiPerSec).toBe(200n);
  });

  it("clamps unlisted outflow to zero when listed streams exceed the measured total", async () => {
    // Possible for one block around an update: never let this go negative.
    const facts = await readFacts(
      { client: client({
          balance: [5000n, 400n, 0n],
          accountFlowrate: -50n,
          [`flow:${A}`]: [0n, 60n, 0n, 0n],
          [`flow:${B}`]: [0n, 40n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.unlistedOutflowWeiPerSec).toBe(0n);
  });

  it("redacts a hosted RPC provider's key baked into a failed read's error text (I4)", async () => {
    // A hosted provider (Alchemy, Infura, ...) embeds its key in the URL
    // path, not as basic-auth, so it survives into a thrown
    // HttpRequestError's message untouched. deps.rpcUrl exists purely so
    // readFacts can strip it back out before the text becomes a
    // ReadFailure.reason.
    const FAKE_KEY = "sk-fake-provider-key-9f3a";
    const rpcUrl = `https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}`;
    const error = await readFacts(
      {
        client: {
          readContract: async () => {
            throw new Error(`fetch failed for ${rpcUrl}`);
          },
        },
        rpcUrl,
      },
      policy(),
      1_700_000_000,
    ).catch((e: unknown) => e as ReadIncompleteError);

    expect(error).toBeInstanceOf(ReadIncompleteError);
    const readError = error as ReadIncompleteError;
    for (const failure of readError.failures) {
      expect(failure.reason).not.toContain(FAKE_KEY);
    }
    expect(readError.message).not.toContain(FAKE_KEY);
    expect(readError.failures[0]?.reason).toContain("[redacted]");
  });

  it("fails closed when getAccountFlowrate fails, exactly as a failing getFlowInfo does", async () => {
    await expect(
      readFacts(
        { client: client({
            balance: [5000n, 400n, 0n],
            accountFlowrate: new Error("RPC timeout"),
            [`flow:${A}`]: [0n, 60n, 0n, 0n],
            [`flow:${B}`]: [0n, 40n, 0n, 0n],
          }) },
        policy(),
        1_700_000_000,
      ),
    ).rejects.toBeInstanceOf(ReadIncompleteError);
  });
});

/**
 * `tests/fixtures/sepolia-reads.json` records the response shape of three
 * real reads against Sepolia (per its own `_comment`), confirming the ABI
 * fragments in `src/chain/abi.ts` are known-good. Per spec section 10
 * ("reader — recorded fixtures from real Sepolia reads, plus one live read
 * asserted against the fixture shape."), this asserts the fixture's shape --
 * the arity of each recorded tuple -- matches what `abi.ts` declares. This
 * asserts arity only, never a value: the recorded balances and rates go
 * stale the moment the chain moves, but a tuple's length does not, so this
 * cannot rot the way a value assertion would.
 */
describe("sepolia-reads fixture shape", () => {
  const fixturePath = fileURLToPath(new URL("../fixtures/sepolia-reads.json", import.meta.url));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    chainId: number;
    blockNumber: number;
    reads: { contract: string; function?: string; result?: unknown; check?: string }[];
  };

  function abiOutputCount(functionName: string): number {
    const fn = [...CFA_FORWARDER_READ_ABI, ...SUPER_TOKEN_READ_ABI].find((f) => f.name === functionName);
    if (!fn) throw new Error(`no ABI fragment named ${functionName}`);
    return fn.outputs.length;
  }

  it("getFlowInfo's recorded result has one element per output the ABI declares", () => {
    const read = fixture.reads.find((r) => r.function?.startsWith("getFlowInfo"));
    expect(Array.isArray(read?.result)).toBe(true);
    const result = read?.result as unknown[];
    expect(result.length).toBe(abiOutputCount("getFlowInfo"));
  });

  it("realtimeBalanceOf's recorded result has one element per output the ABI declares", () => {
    const read = fixture.reads.find((r) => r.function?.startsWith("realtimeBalanceOf"));
    expect(Array.isArray(read?.result)).toBe(true);
    const result = read?.result as unknown[];
    expect(result.length).toBe(abiOutputCount("realtimeBalanceOf"));
  });

  it("is pinned to Sepolia -- this reader has no other chain to read", () => {
    expect(fixture.chainId).toBe(11155111);
  });
});
