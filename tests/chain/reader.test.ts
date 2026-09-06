import { describe, expect, it } from "vitest";
import { readFacts, ReadIncompleteError } from "../../src/chain/reader.js";
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
});
