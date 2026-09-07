import { describe, expect, it } from "vitest";
import { renderReport } from "../../src/report/render.js";
import { decide } from "../../src/policy/decide.js";
import type { Address, Adjustment, Facts, Policy } from "../../src/policy/types.js";
import type { RunRecord } from "../../src/runner/record.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

/** Matches the fixtures in tests/runner/run.test.ts (Task 4's suite). */
function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [
      { address: CRIT, label: "crit", tier: "critical", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 80n },
      { address: STD, label: "std", tier: "standard", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 50n },
      { address: DISC, label: "disc", tier: "discretionary", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
    ...over,
  };
}

function facts(balance: bigint, rates: [bigint, bigint, bigint]): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: balance,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: rates[0] },
      { receiver: STD, flowRateWeiPerSec: rates[1] },
      { receiver: DISC, flowRateWeiPerSec: rates[2] },
    ],
    unlistedOutflowWeiPerSec: 0n,
  };
}

function adjustment(over: Partial<Adjustment> = {}): Adjustment {
  return {
    receiver: CRIT,
    fromRateWeiPerSec: 100n,
    toRateWeiPerSec: 80n,
    reason: "budget-shed",
    ...over,
  };
}

/**
 * A minimal landed run; each test overrides only what it asserts on.
 *
 * The brief's fixture for a "landed" outcome omitted `effectiveGasPriceWei`
 * and `sponsored`. Both are required by the real `ExecutionOutcome` union in
 * src/keeperhub/execute.ts (no `executionId` field exists anywhere on it),
 * so this fixture carries both to satisfy strict typechecking.
 */
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: "2026-09-10T12:00:00.000Z",
    nowSec: 1_757_505_600,
    facts: facts(15_000n, [100n, 100n, 100n]),
    decision: decide(facts(15_000n, [100n, 100n, 100n]), policy()),
    outcomes: [
      {
        adjustment: adjustment(),
        outcome: {
          status: "landed",
          transactionHash: "0xabc",
          transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
          gasUsedWei: "1",
          effectiveGasPriceWei: "1000000000",
          sponsored: false,
        },
      },
    ],
    escalations: [],
    ...over,
  };
}

describe("renderReport", () => {
  it("shows the runway of the most recent run", () => {
    // 15000 wei available at 300 wei/sec is 50 seconds of runway.
    expect(renderReport([record()])).toContain("50");
  });

  it("links every landed transaction to the explorer link the record carries", () => {
    expect(renderReport([record()])).toContain("https://sepolia.etherscan.io/tx/0xabc");
  });

  it("is self-contained: no script, no external stylesheet, no remote image", () => {
    const html = renderReport([record()]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain('src="http');
  });

  it("escapes a value that came off the chain", () => {
    const hostile = record({
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: {
            status: "refused",
            stage: "broadcast",
            detail: '<img src=x onerror="alert(1)">',
          },
        },
      ],
    });
    const html = renderReport([hostile]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("states plainly when a run took no action", () => {
    const quiet = record({
      decision: decide(facts(30_000n, [100n, 100n, 100n]), policy()),
      outcomes: [],
    });
    expect(renderReport([quiet])).toMatch(/no action/i);
  });

  it("renders an empty history without throwing", () => {
    expect(() => renderReport([])).not.toThrow();
  });

  it("shows an unresolved outcome's detail as well", () => {
    const unresolved = record({
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: { status: "unresolved", detail: "broadcast request failed: network timeout" },
        },
      ],
    });
    expect(renderReport([unresolved])).toContain("network timeout");
  });

  it("shows a run whose chain read failed with no facts and no decision", () => {
    const failed = record({ facts: null, decision: null, outcomes: [] });
    expect(() => renderReport([failed])).not.toThrow();
    expect(renderReport([failed])).toMatch(/no action/i);
  });

  it("marks sponsorship unknown rather than 'not sponsored' when the outcome carries no sponsored field", () => {
    const noSponsoredField = record({
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: {
            status: "landed",
            transactionHash: "0xabc",
            transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
            gasUsedWei: "1",
            effectiveGasPriceWei: "1000000000",
            // sponsored intentionally omitted: an ordinary protocol-write
            // response never carries it.
          },
        },
      ],
    });
    const html = renderReport([noSponsoredField]);
    expect(html).toContain("(sponsorship unknown)");
    expect(html).not.toContain("(not sponsored)");
  });

  it("still shows '(not sponsored)' when the outcome explicitly says sponsored: false", () => {
    const explicitlyUnsponsored = record({
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: {
            status: "landed",
            transactionHash: "0xabc",
            transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
            gasUsedWei: "1",
            effectiveGasPriceWei: "1000000000",
            sponsored: false,
          },
        },
      ],
    });
    expect(renderReport([explicitlyUnsponsored])).toContain("(not sponsored)");
  });

  it("renders the most recent run first regardless of array order", () => {
    const older = record({ startedAt: "2026-09-09T00:00:00.000Z" });
    const newer = record({
      startedAt: "2026-09-11T00:00:00.000Z",
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: {
            status: "landed",
            transactionHash: "0xnewer",
            transactionLink: "https://sepolia.etherscan.io/tx/0xnewer",
            gasUsedWei: "1",
            effectiveGasPriceWei: "1",
            sponsored: false,
          },
        },
      ],
    });
    const html = renderReport([older, newer]);
    expect(html.indexOf("0xnewer")).toBeLessThan(html.indexOf("0xabc"));
  });
});
