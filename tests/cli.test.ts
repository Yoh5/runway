import { mkdtemp, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicClientLike, ReaderDeps } from "../src/chain/reader.js";
import { readPolicy, readRuns, runCli, type CliDeps } from "../src/cli.js";
import type { ExecutionOutcome, ExecutorDeps } from "../src/keeperhub/execute.js";
import { decide } from "../src/policy/decide.js";
import { PolicyError } from "../src/policy/load.js";
import type { Address, Facts, Policy } from "../src/policy/types.js";
import type { RunRecord } from "../src/runner/record.js";

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

const LANDED: ExecutionOutcome = {
  status: "landed",
  transactionHash: "0xabc",
  transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
  gasUsedWei: "1",
  effectiveGasPriceWei: "1000000000",
  sponsored: false,
};

/** A `PublicClientLike` that fails loudly if a dry run ever reaches the chain client. */
function unusedClient(): PublicClientLike {
  return {
    readContract: async () => {
      throw new Error("test double: readContract should not be called — readFacts is stubbed directly");
    },
  };
}

/** A structurally valid but never-used `ExecutorDeps`, for tests that must prove it is never built. */
function fakeExecutorDeps(): ExecutorDeps {
  return {
    fetch: async () => {
      throw new Error("test double: fetch should not be called");
    },
    baseUrl: "https://example.invalid",
    apiKey: "unused",
    simulate: async () => ({ reverted: false }),
    pollBudgetMs: 0,
    sleep: async () => {},
  };
}

function stubDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    readPolicy: async () => policy(),
    now: () => 1_700_000_000,
    buildReaderDeps: (): ReaderDeps => ({ client: unusedClient() }),
    readFacts: async () => facts(15_000n, [100n, 100n, 100n]),
    buildExecutorDeps: fakeExecutorDeps,
    execute: async () => LANDED,
    notify: async () => {},
    mkdir: async () => undefined,
    writeFile: async () => {},
    readRuns: async () => [],
    log: () => {},
    table: () => {},
    ...over,
  };
}

describe("runCli — dry run", () => {
  it("produces the decision the policy engine would produce for those facts", async () => {
    const p = policy();
    const f = facts(15_000n, [100n, 100n, 100n]);
    const deps = stubDeps({
      readPolicy: async () => p,
      readFacts: async () => f,
    });

    const decision = await runCli(deps, ["policy.yaml", "--dry-run"]);

    expect(decision).toEqual(decide(f, p));
    // Sanity: these facts breach the minimum runway, so the dry run is
    // actually exercising the "reduce" branch, not a vacuous hold.
    expect(decision?.kind).toBe("reduce");
    expect(decision?.adjustments.length).toBeGreaterThan(0);
  });

  it("constructs no executor and performs no write", async () => {
    let executorBuilds = 0;
    let executeCalls = 0;
    let mkdirCalls = 0;
    let writeFileCalls = 0;

    const deps = stubDeps({
      buildExecutorDeps: () => {
        executorBuilds += 1;
        return fakeExecutorDeps();
      },
      execute: async () => {
        executeCalls += 1;
        return LANDED;
      },
      mkdir: async () => {
        mkdirCalls += 1;
        return undefined;
      },
      writeFile: async () => {
        writeFileCalls += 1;
      },
    });

    // These facts breach the minimum runway (see the test above), so a
    // real dry run here *would* have adjustments to execute if the dry-run
    // branch were wired wrong. It must still call none of these.
    await runCli(deps, ["policy.yaml", "--dry-run"]);

    expect(executorBuilds).toBe(0);
    expect(executeCalls).toBe(0);
    expect(mkdirCalls).toBe(0);
    expect(writeFileCalls).toBe(0);
  });

  it("fails with a clear error, not a stack trace, for a policy path that does not exist", async () => {
    const deps = stubDeps({ readPolicy });

    await expect(runCli(deps, ["/definitely/does-not-exist-9f3a.yaml", "--dry-run"])).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });

  it("fails with a clear PolicyError, not a stack trace, for a malformed policy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runway-cli-test-"));
    const badPolicyPath = join(dir, "bad-policy.yaml");
    await nodeWriteFile(badPolicyPath, "version: 2\n", "utf8");

    const deps = stubDeps({ readPolicy });

    await expect(runCli(deps, [badPolicyPath, "--dry-run"])).rejects.toThrow(PolicyError);
  });

  it("fails with a clear usage error when no policy path is given", async () => {
    const deps = stubDeps();
    await expect(runCli(deps, ["--dry-run"])).rejects.toThrow(/usage/i);
  });
});

function landedRecord(startedAt: string): RunRecord {
  return {
    startedAt,
    nowSec: 1_700_000_000,
    facts: facts(15_000n, [100n, 100n, 100n]),
    decision: decide(facts(15_000n, [100n, 100n, 100n]), policy()),
    outcomes: [{ adjustment: { receiver: DISC, fromRateWeiPerSec: 100n, toRateWeiPerSec: 0n, reason: "budget-shed" }, outcome: LANDED }],
    escalations: [],
  };
}

describe("runCli — --report (I3)", () => {
  it("reads runs via deps.readRuns, renders them, and writes the HTML with deps.writeFile", async () => {
    const written: { path: string; data: string }[] = [];
    let mkdirPath: string | undefined;
    let readRunsDir: string | undefined;
    const deps = stubDeps({
      readRuns: async (dir) => {
        readRunsDir = dir;
        return [landedRecord("2026-09-10T12:00:00.000Z")];
      },
      mkdir: async (dirPath) => {
        mkdirPath = dirPath;
        return undefined;
      },
      writeFile: async (filePath, data) => {
        written.push({ path: filePath, data });
      },
    });

    await runCli(deps, ["--report", "out/report.html"]);

    expect(readRunsDir).toMatch(/runs$/);
    expect(mkdirPath).toMatch(/out$/);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toMatch(/out[\\/]report\.html$/);
    expect(written[0]?.data).toContain("<!doctype html>");
    expect(written[0]?.data).toContain("https://sepolia.etherscan.io/tx/0xabc");
  });

  it("defaults the output path to runs/report.html when none is given", async () => {
    const written: { path: string; data: string }[] = [];
    const deps = stubDeps({
      readRuns: async () => [],
      writeFile: async (filePath, data) => {
        written.push({ path: filePath, data });
      },
    });

    await runCli(deps, ["--report"]);

    expect(written[0]?.path.replace(/\\/g, "/")).toMatch(/runs\/report\.html$/);
    expect(written[0]?.data).toMatch(/no runs recorded yet/i);
  });

  it("requires no policy path at all -- --report alone does not throw the usage error", async () => {
    const deps = stubDeps({ readRuns: async () => [] });
    await expect(runCli(deps, ["--report"])).resolves.toBeUndefined();
  });

  it("constructs no executor and calls readFacts/execute never (a report run touches no chain)", async () => {
    let readFactsCalls = 0;
    let executeCalls = 0;
    const deps = stubDeps({
      readRuns: async () => [],
      readFacts: async () => {
        readFactsCalls += 1;
        return facts(15_000n, [100n, 100n, 100n]);
      },
      execute: async () => {
        executeCalls += 1;
        return LANDED;
      },
    });
    await runCli(deps, ["--report"]);
    expect(readFactsCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });
});

describe("readRuns (I3)", () => {
  it("reads and revives every runs/*.json file in a directory", async () => {
    const { toSerialisable } = await import("../src/runner/record.js");
    const dir = await mkdtemp(join(tmpdir(), "runway-runs-test-"));
    const record = landedRecord("2026-09-10T12:00:00.000Z");
    await nodeWriteFile(join(dir, "run-1.json"), JSON.stringify(toSerialisable(record)), "utf8");
    await nodeWriteFile(join(dir, "not-a-run.txt"), "ignore me", "utf8");

    const records = await readRuns(dir);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
    expect(typeof records[0]?.decision?.runwaySec).toBe("bigint");
  });

  it("reads as no runs at all when the directory does not exist yet", async () => {
    const records = await readRuns(join(tmpdir(), "runway-runs-does-not-exist-9f3a"));
    expect(records).toEqual([]);
  });
});

describe("module import safety (C1)", () => {
  it("importing src/cli.ts does not run main(): process.exitCode is untouched", () => {
    // src/cli.ts is imported at the top of this very file (as it is by every
    // test in this suite), which is exactly the scenario the entrypoint
    // guard has to defend: a plain `import` must never execute `main()`.
    // Before the guard, `main()` ran unconditionally at module scope, took
    // the "no policy path" branch against the test runner's own argv, and
    // its `.catch` set `process.exitCode = 1` — observable proof the import
    // alone triggered a real run of the CLI's top-level logic. In the real
    // danger scenario (a readable policy path in argv, the four KeeperHub/RPC
    // env vars exported) that same unconditional call would broadcast a real
    // transaction.
    expect(process.exitCode).not.toBe(1);
  });
});
