import { describe, expect, it, vi } from "vitest";
import { createTriggerHandler } from "../../src/trigger/handle.js";
import type { RunRecord } from "../../src/runner/record.js";

/**
 * The trigger is the one surface in this project that lets something other
 * than a person at a keyboard move money. Every test here is about what it
 * refuses, and about the two states a scheduler can put it in that a CLI
 * never can: two ticks at once, and a tick that fails without anyone
 * watching.
 */

const TOKEN = "x".repeat(48);
const WRONG = "y".repeat(48); // same length: a length check must not be what rejects it

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: "2026-09-09T00:00:00.000Z",
    nowSec: 1_788_900_000,
    facts: {
      nowSec: 1_788_900_000,
      availableBalanceWei: 1_000n,
      depositWei: 10n,
      streams: [],
      unlistedOutflowWeiPerSec: 0n,
    },
    decision: {
      kind: "reduce",
      runwaySec: 84_450n,
      breach: true,
      adjustments: [
        {
          receiver: "0x000000000000000000000000000000000000dead",
          fromRateWeiPerSec: 100n,
          toRateWeiPerSec: 60n,
          reason: "budget-shed",
        },
      ],
      escalation: { kind: "floors-exceed-budget", detail: "40 wei/sec above budget" },
    },
    outcomes: [
      {
        adjustment: {
          receiver: "0x000000000000000000000000000000000000dead",
          fromRateWeiPerSec: 100n,
          toRateWeiPerSec: 60n,
          reason: "budget-shed",
        },
        outcome: {
          status: "landed",
          transactionHash: "0xabc",
          transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
          contract: "status",
        },
      },
    ],
    escalations: [
      { kind: "floors-exceed-budget", detail: "40 wei/sec above budget", delivered: false },
    ],
    ...overrides,
  } as RunRecord;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handlerWith(runTick: () => Promise<RunRecord>) {
  const log = vi.fn();
  return { handle: createTriggerHandler({ expectedToken: TOKEN, runTick, log }), log };
}

describe("the trigger refuses everything it was not asked for", () => {
  it("rejects a request carrying no token, and runs nothing", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: undefined });

    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe("unauthorized");
    expect(runTick).not.toHaveBeenCalled();
  });

  it("rejects a wrong token of the right length, and runs nothing", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: WRONG });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unauthorized");
    expect(runTick).not.toHaveBeenCalled();
  });

  it("rejects a GET on the tick path even with the right token", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "GET", path: "/tick", token: TOKEN });

    expect(response.status).toBe(405);
    expect(response.body.code).toBe("method-not-allowed");
    expect(runTick).not.toHaveBeenCalled();
  });

  it("rejects an unknown path even with the right token", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/run", token: TOKEN });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("not-found");
    expect(runTick).not.toHaveBeenCalled();
  });

  it("never puts the expected token in a response body, including when it rejects one", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    for (const request of [
      { method: "POST", path: "/tick", token: undefined },
      { method: "POST", path: "/tick", token: WRONG },
      { method: "POST", path: "/tick", token: TOKEN },
      { method: "GET", path: "/health", token: undefined },
    ]) {
      const response = await handle(request);
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
      expect(JSON.stringify(response.body)).not.toContain(WRONG);
    }
  });

  it("refuses to exist at all if the expected token is too short to be a secret", () => {
    expect(() =>
      createTriggerHandler({ expectedToken: "short", runTick: async () => record(), log: () => {} }),
    ).toThrow(/32/);
  });
});

describe("the trigger runs a tick, and reports what happened", () => {
  it("runs exactly one tick and summarises the record it produced", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.result).toMatchObject({
      startedAt: "2026-09-09T00:00:00.000Z",
      decision: "reduce",
      runwaySec: "84450",
      breach: true,
      adjustments: 1,
      writes: [
        {
          receiver: "0x000000000000000000000000000000000000dead",
          status: "landed",
          transactionHash: "0xabc",
        },
      ],
      escalations: [{ kind: "floors-exceed-budget", delivered: false }],
    });
  });

  it("summarises a run that never reached a decision, rather than throwing on it", async () => {
    const runTick = vi.fn(async () =>
      record({
        facts: null,
        decision: null,
        outcomes: [],
        escalations: [{ kind: "read-incomplete", detail: "rpc unreachable", delivered: true }],
      }),
    );
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      decision: null,
      runwaySec: null,
      breach: null,
      adjustments: 0,
      writes: [],
      escalations: [{ kind: "read-incomplete", delivered: true }],
    });
  });

  it("keeps an unbounded runway distinguishable from a run that never decided", async () => {
    // `decide` returns runwaySec: null when there is no net outflow -- the
    // treasury is not draining at all. That is the healthiest state there
    // is, and it must not read the same way as a failed read. The pair
    // (decision, runwaySec) is what tells them apart.
    const runTick = vi.fn(async () =>
      record({
        decision: {
          kind: "hold",
          runwaySec: null,
          breach: false,
          adjustments: [],
          escalation: null,
        },
        outcomes: [],
        escalations: [],
      }),
    );
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(response.body.result).toMatchObject({
      decision: "hold",
      runwaySec: null,
      breach: false,
    });
  });

  it("answers health without a token, and without running a tick", async () => {
    const runTick = vi.fn(async () => record());
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "GET", path: "/health", token: undefined });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(runTick).not.toHaveBeenCalled();
  });
});

describe("two ticks at once", () => {
  it("refuses the second while the first is still running, and runs the tick once", async () => {
    const gate = deferred<RunRecord>();
    const runTick = vi.fn(() => gate.promise);
    const { handle } = handlerWith(runTick);

    const first = handle({ method: "POST", path: "/tick", token: TOKEN });
    const second = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(second.body.code).toBe("in-progress");
    expect(runTick).toHaveBeenCalledTimes(1);

    gate.resolve(record());
    expect((await first).status).toBe(200);
  });

  it("accepts the next tick once the first has finished", async () => {
    const gate = deferred<RunRecord>();
    const runTick = vi.fn(() => gate.promise);
    const { handle } = handlerWith(runTick);

    const first = handle({ method: "POST", path: "/tick", token: TOKEN });
    gate.resolve(record());
    await first;

    const second = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(second.status).toBe(200);
    expect(runTick).toHaveBeenCalledTimes(2);
  });
});

describe("a tick that fails with nobody watching", () => {
  it("answers 500 with the reason, and does not claim the run succeeded", async () => {
    const runTick = vi.fn(async () => {
      throw new Error("rpc unreachable");
    });
    const { handle } = handlerWith(runTick);

    const response = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe("run-failed");
    expect(response.body.error).toContain("rpc unreachable");
  });

  it("releases the lock when a tick fails, so the next schedule is not blocked for ever", async () => {
    let calls = 0;
    const runTick = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("rpc unreachable");
      return record();
    });
    const { handle } = handlerWith(runTick);

    await handle({ method: "POST", path: "/tick", token: TOKEN });
    const second = await handle({ method: "POST", path: "/tick", token: TOKEN });

    expect(second.status).toBe(200);
    expect(runTick).toHaveBeenCalledTimes(2);
  });
});
