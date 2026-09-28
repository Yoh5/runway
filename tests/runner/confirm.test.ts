/**
 * A receipt is not a change.
 *
 * KeeperHub answering "landed" proves a transaction was included. It does not
 * prove the stream now runs at the rate this agent asked for. The two come
 * apart in ways that matter: a transaction can land and revert, a relayer can
 * report on the wrong chain, and -- the case that actually happened first --
 * an outcome can come back `unresolved` with a hash, leaving a run unable to
 * say whether the treasury paid.
 *
 * So the runner reads the rate back off the chain after it writes, and records
 * what it found. That read is the only thing that can settle an unresolved
 * write, and the only thing that can catch a landed write that changed
 * nothing.
 */

import { describe, expect, it } from "vitest";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import type { ExecutionOutcome } from "../../src/keeperhub/execute.js";
import { type RunDeps, runOnce } from "../../src/runner/run.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;

function policy(): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [
      {
        address: CRIT,
        label: "crit",
        tier: "critical",
        committedRateWeiPerSec: 100n,
        floorRateWeiPerSec: 10n,
      },
      {
        address: STD,
        label: "std",
        tier: "standard",
        committedRateWeiPerSec: 100n,
        floorRateWeiPerSec: 10n,
      },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

/** Balance far below the band, so `decide` sheds and the runner writes. */
function facts(): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: 1_000n,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: 100n },
      { receiver: STD, flowRateWeiPerSec: 100n },
    ],
    unlistedOutflowWeiPerSec: 0n,
  };
}

const landed: ExecutionOutcome = {
  status: "landed",
  transactionHash: "0xabc",
  transactionLink: "https://example.invalid/tx/0xabc",
};

function deps(overrides: Partial<RunDeps> = {}): RunDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    readFacts: async () => facts(),
    execute: async () => landed,
    notify: async (_webhook, payload) => {
      sent.push(payload);
    },
    ...overrides,
  };
}

describe("confirming a write against the chain", () => {
  it("records the rate it read back, per adjustment", async () => {
    const asked: Address[] = [];
    const record = await runOnce(
      deps({
        // The chain agrees with every adjustment.
        confirm: async (_policy, adjustment) => {
          asked.push(adjustment.receiver);
          return adjustment.toRateWeiPerSec;
        },
      }),
      policy(),
      1_700_000_000,
    );

    expect(record.outcomes.length).toBeGreaterThan(0);
    expect(asked).toEqual(record.outcomes.map((o) => o.adjustment.receiver));
    for (const { confirmation } of record.outcomes) {
      expect(confirmation?.matches).toBe(true);
      expect(confirmation?.rateWeiPerSec).toBeTypeOf("bigint");
    }
  });

  it("escalates when the chain does not show what the run wrote", async () => {
    const d = deps({
      // Every write reported "landed", and yet nothing moved.
      confirm: async (_policy, adjustment) => adjustment.fromRateWeiPerSec,
    });
    const record = await runOnce(d, policy(), 1_700_000_000);

    const unconfirmed = record.escalations.filter((e) => e.kind === "write-unconfirmed");
    expect(unconfirmed.length).toBe(1);
    expect(unconfirmed[0]?.detail).toContain("does not show");
    for (const { confirmation } of record.outcomes) {
      expect(confirmation?.matches).toBe(false);
    }
  });

  // The case the feature was written for.
  it("settles an unresolved write that the chain shows did take effect", async () => {
    const unresolved: ExecutionOutcome = {
      status: "unresolved",
      transactionHash: "0xdef",
      detail: "gateway timed out",
    };
    const d = deps({
      execute: async () => unresolved,
      confirm: async (_policy, adjustment) => adjustment.toRateWeiPerSec,
    });

    const record = await runOnce(d, policy(), 1_700_000_000);

    // It still escalates that the outcome was unresolved -- that happened and
    // the record must keep it -- but the confirmation says how it turned out.
    expect(record.escalations.some((e) => e.kind === "write-outcome-unknown")).toBe(true);
    for (const { confirmation } of record.outcomes) {
      expect(confirmation?.matches).toBe(true);
    }
    expect(record.escalations.some((e) => e.kind === "write-unconfirmed")).toBe(false);
  });

  it("does not confirm a refusal, because nothing was sent", async () => {
    const refused: ExecutionOutcome = {
      status: "refused",
      stage: "simulate",
      detail: "outside the mandate",
    };
    let calls = 0;
    const d = deps({
      execute: async () => refused,
      confirm: async () => {
        calls += 1;
        return 0n;
      },
    });

    const record = await runOnce(d, policy(), 1_700_000_000);

    expect(calls).toBe(0);
    for (const { confirmation } of record.outcomes) {
      expect(confirmation).toBeUndefined();
    }
  });

  /**
   * A read-back that fails is not a write that failed. The receipt already
   * said the transaction landed; all that is missing is our confirmation of
   * it. Escalating here would page a human on every RPC hiccup, so it is
   * recorded and stays visible instead.
   */
  it("records a failed read-back without escalating on it", async () => {
    const d = deps({
      confirm: async () => {
        throw new Error("rpc unreachable");
      },
    });

    const record = await runOnce(d, policy(), 1_700_000_000);

    expect(record.escalations.some((e) => e.kind === "write-unconfirmed")).toBe(false);
    for (const { confirmation } of record.outcomes) {
      expect(confirmation?.matches).toBe(null);
      expect(confirmation?.detail).toContain("rpc unreachable");
    }
  });

  it("runs exactly as before when no confirmer is wired", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);

    expect(record.outcomes.length).toBeGreaterThan(0);
    for (const { confirmation } of record.outcomes) {
      expect(confirmation).toBeUndefined();
    }
    expect(record.escalations.some((e) => e.kind === "write-unconfirmed")).toBe(false);
  });

  it("confirms after every write, not between them", async () => {
    // Reading between writes would report a chain that is still mid-flight.
    // The order must be: all writes, then all reads.
    const order: string[] = [];
    const d = deps({
      execute: async (_p, adjustment) => {
        order.push(`write ${adjustment.receiver.slice(0, 6)}`);
        return landed;
      },
      confirm: async (_p, adjustment) => {
        order.push(`read ${adjustment.receiver.slice(0, 6)}`);
        return adjustment.toRateWeiPerSec;
      },
    });

    await runOnce(d, policy(), 1_700_000_000);

    const firstRead = order.findIndex((s) => s.startsWith("read"));
    const lastWrite = order.map((s) => s.startsWith("write")).lastIndexOf(true);
    expect(firstRead).toBeGreaterThan(lastWrite);
  });
});
