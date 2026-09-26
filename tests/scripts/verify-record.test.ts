import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";
import { toSerialisable } from "../../src/runner/record.js";
import type { RunRecord } from "../../src/runner/record.js";
import { policyDigest } from "../../src/runner/verify.js";
import { verifyRunsDirectory } from "../../scripts/lib/verify-record.js";

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
        floorRateWeiPerSec: 80n,
      },
      {
        address: STD,
        label: "std",
        tier: "standard",
        committedRateWeiPerSec: 100n,
        floorRateWeiPerSec: 50n,
      },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

function record(startedAt: string, given: Policy): RunRecord {
  const facts: Facts = {
    nowSec: 1_700_000_000,
    availableBalanceWei: 10_000n,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: 100n },
      { receiver: STD, flowRateWeiPerSec: 100n },
    ],
    unlistedOutflowWeiPerSec: 0n,
  };
  return {
    startedAt,
    nowSec: facts.nowSec,
    policyDigest: policyDigest(given),
    agentVersion: "test",
    facts,
    decision: decide(facts, given),
    outcomes: [],
    escalations: [],
  };
}

/** A directory whose listing and file reads come from a map, not from disk. */
function directory(files: Record<string, string>) {
  return {
    list: (dir: string) => {
      const prefix = `${dir}/`;
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
      if (names.length === 0 && !Object.keys(files).some((path) => path.startsWith(dir))) {
        throw new Error(`ENOENT: no such directory, scandir '${dir}'`);
      }
      return names;
    },
    read: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file '${path}'`);
      return content;
    },
  };
}

describe("verifyRunsDirectory -- a gate that can never fail is not a gate", () => {
  it("verifies the records it finds", () => {
    const given = policy();
    const files = {
      "runs/a.json": JSON.stringify(toSerialisable(record("2026-01-01T00:00:00.000Z", given))),
      "runs/b.json": JSON.stringify(toSerialisable(record("2026-01-02T00:00:00.000Z", given))),
    };

    const outcome = verifyRunsDirectory({ policy: given, dir: "runs", explicit: false, ...directory(files) });

    expect(outcome.ok).toBe(true);
    expect(outcome.verdicts).toHaveLength(2);
    expect(outcome.summary).toBe("2/2 records verified");
  });

  it("fails when a record does not follow from its own facts", () => {
    const given = policy();
    const tampered = record("2026-01-01T00:00:00.000Z", given);
    tampered.decision = { kind: "hold", runwaySec: null, breach: false, adjustments: [], escalation: null };
    const files = { "runs/a.json": JSON.stringify(toSerialisable(tampered)) };

    const outcome = verifyRunsDirectory({ policy: given, dir: "runs", explicit: false, ...directory(files) });

    expect(outcome.ok).toBe(false);
  });

  // The bug this file was written for. CI ran `verify-record` on a checkout
  // where `runs/` is gitignored: the directory was absent, the script said
  // "nothing to verify" and exited zero. Green forever, proving nothing.
  it("fails when a directory named on the command line does not exist", () => {
    const outcome = verifyRunsDirectory({
      policy: policy(),
      dir: "docs/evidence",
      explicit: true,
      ...directory({}),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("docs/evidence");
  });

  it("fails when a directory named on the command line holds no records", () => {
    const outcome = verifyRunsDirectory({
      policy: policy(),
      dir: "docs/evidence",
      explicit: true,
      ...directory({ "docs/evidence/report.html": "<p>not a record</p>" }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("no records");
  });

  // An operator who just cloned the repository and ran `pnpm verify-record`
  // has no runs yet. That is not a failure, and telling them it is would
  // teach them to ignore the one gate that matters.
  it("passes on a missing default directory, and says so", () => {
    const outcome = verifyRunsDirectory({
      policy: policy(),
      dir: "runs",
      explicit: false,
      ...directory({}),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain("nothing to verify");
  });
});
