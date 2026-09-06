import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { CFA_FORWARDER_ADDRESS } from "./chain/abi.js";
import { readFacts, type ReaderDeps } from "./chain/reader.js";
import { executeAdjustment, type ExecutorDeps, type SimulateFn } from "./keeperhub/execute.js";
import { decide } from "./policy/decide.js";
import { loadPolicy } from "./policy/load.js";
import type { Adjustment, Decision, Policy } from "./policy/types.js";
import { reason, redact } from "./redact.js";
import { renderReport } from "./report/render.js";
import { fromSerialisable, toSerialisable } from "./runner/record.js";
import type { RunRecord } from "./runner/record.js";
import { runOnce, type RunDeps } from "./runner/run.js";

/**
 * Not published anywhere else in this codebase (Task 6 only reads the chain,
 * never writes to it), so it is declared here, next to the one call site
 * that needs it: the CFAv1Forwarder ABI fragment for the write `simulate`
 * checks locally before any broadcast.
 */
const CFA_FORWARDER_UPDATE_FLOW_ABI = [
  {
    type: "function",
    name: "updateFlow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
      { name: "flowrate", type: "int96" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function printDecisionTable(
  decision: Decision,
  log: (message: string) => void,
  table: (rows: Record<string, string>[]) => void,
): void {
  log(`decision: ${decision.kind}`);
  log(`runwaySec: ${decision.runwaySec ?? "n/a"}`);
  log(`breach: ${decision.breach}`);
  if (decision.escalation) {
    log(`escalation: ${decision.escalation.kind} — ${decision.escalation.detail}`);
  }
  if (decision.adjustments.length === 0) {
    log("adjustments: none");
    return;
  }
  table(
    decision.adjustments.map((a) => ({
      receiver: a.receiver,
      from: a.fromRateWeiPerSec.toString(),
      to: a.toRateWeiPerSec.toString(),
      reason: a.reason,
    })),
  );
}

export async function readPolicy(policyPath: string): Promise<Policy> {
  const yamlText = await readFile(policyPath, "utf8");
  return loadPolicy(yamlText);
}

/**
 * Reads every `runs/*.json` file, reviving each back into a `RunRecord`. An
 * empty or missing directory reads as no runs at all — the report renders
 * "no runs recorded yet" rather than the CLI throwing before a single run has
 * ever landed.
 */
export async function readRuns(dirPath: string): Promise<RunRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: RunRecord[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const text = await readFile(path.join(dirPath, entry), "utf8");
    records.push(fromSerialisable(JSON.parse(text)));
  }
  return records;
}

function buildReaderDeps(): ReaderDeps {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  // viem's own `readContract` overloads are generic in a way `PublicClientLike`
  // (deliberately narrow, so a test double can implement it with no viem
  // import at all) does not accept structurally. The adapter is the one place
  // that gap is bridged, with a cast that changes no behaviour at runtime.
  return {
    client: {
      readContract: (args) =>
        client.readContract(args as unknown as Parameters<typeof client.readContract>[0]),
    },
    // Carried purely so a failed read can redact a hosted provider's key back
    // out of the error text: it travels baked into the URL path, which
    // survives into a thrown HttpRequestError's message untouched.
    rpcUrl,
  };
}

function buildExecutorDeps(): ExecutorDeps {
  const apiKey = requireEnv("KEEPERHUB_API_KEY");
  const baseUrl = requireEnv("KEEPERHUB_BASE_URL");
  const flowOperator = requireEnv("KEEPERHUB_FLOW_OPERATOR_ADDRESS");
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  const simulate: SimulateFn = async ({ token, sender, receiver, flowRateWeiPerSec }) => {
    try {
      await client.simulateContract({
        address: CFA_FORWARDER_ADDRESS,
        abi: CFA_FORWARDER_UPDATE_FLOW_ABI,
        functionName: "updateFlow",
        args: [token, sender, receiver, flowRateWeiPerSec, "0x"],
        account: flowOperator as `0x${string}`,
      });
      return { reverted: false };
    } catch (error) {
      // Redacted here too, not only downstream in executeAdjustment: this is
      // the closure that actually holds the RPC URL, and a viem
      // HttpRequestError against a hosted provider embeds its key in the URL
      // path itself, not as basic-auth, so nothing strips it upstream.
      return { reverted: true, reason: redact(reason(error), [rpcUrl]) };
    }
  };

  return {
    fetch: globalThis.fetch,
    baseUrl,
    apiKey,
    rpcUrl,
    simulate,
    pollBudgetMs: 30_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function notifyWebhook(webhook: string, payload: unknown): Promise<void> {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`escalation webhook responded with http ${response.status}`);
  }
}

/**
 * Every collaborator `runCli` needs, as a function — the same shape `RunDeps`
 * gives the runner. This is what lets the dry-run path (the exact path a
 * live Sepolia run depends on) be exercised in a test with no network, no
 * filesystem and no risk of a real broadcast: a test only ever has to supply
 * plain stub functions and count how many times each is called.
 */
export type CliDeps = {
  readPolicy: (policyPath: string) => Promise<Policy>;
  now: () => number;
  buildReaderDeps: () => ReaderDeps;
  readFacts: typeof readFacts;
  buildExecutorDeps: () => ExecutorDeps;
  execute: (
    deps: ExecutorDeps,
    policy: Policy,
    adjustment: Adjustment,
    nowSec: number,
  ) => ReturnType<typeof executeAdjustment>;
  notify: (webhook: string, payload: unknown) => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  readRuns: (dirPath: string) => Promise<RunRecord[]>;
  log: (message: string) => void;
  table: (rows: Record<string, string>[]) => void;
};

/**
 * Runs the CLI's argument-parsed logic against injected collaborators.
 * `main` below is the only place that builds the real (network- and
 * filesystem-touching) `CliDeps`; every other consumer — namely tests — can
 * supply stubs instead.
 *
 * The dry-run branch constructs no `ExecutorDeps` and calls neither
 * `execute`, `mkdir` nor `writeFile`: it reads, decides, prints, and returns
 * the `Decision` it made. Nothing else in this function can turn that
 * decision into a broadcast.
 */
export async function runCli(deps: CliDeps, args: string[]): Promise<Decision | undefined> {
  if (args.includes("--report")) {
    // Reads runs/*.json (not any policy) and writes a static HTML page.
    // Takes no policy path at all, so this branch returns before the usual
    // "usage" check below, which requires one.
    const outPath = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join("runs", "report.html"));
    const records = await deps.readRuns(path.resolve("runs"));
    const html = renderReport(records);
    await deps.mkdir(path.dirname(outPath), { recursive: true });
    await deps.writeFile(outPath, html);
    deps.log(outPath);
    return undefined;
  }

  const dryRun = args.includes("--dry-run");
  const policyPath = args.find((a) => !a.startsWith("--"));
  if (!policyPath) {
    throw new Error("usage: cli.ts <policy.yaml> [--dry-run]");
  }

  const policy = await deps.readPolicy(policyPath);
  const nowSec = deps.now();

  if (dryRun) {
    // Reads and decides but constructs no executor at all, so this path
    // cannot write to the chain even if `decide` returned adjustments.
    const readerDeps = deps.buildReaderDeps();
    const facts = await deps.readFacts(readerDeps, policy, nowSec);
    const decision = decide(facts, policy);
    printDecisionTable(decision, deps.log, deps.table);
    return decision;
  }

  const readerDeps = deps.buildReaderDeps();
  const executorDeps = deps.buildExecutorDeps();
  const runDeps: RunDeps = {
    readFacts: (p, n) => deps.readFacts(readerDeps, p, n),
    execute: (p, adjustment, n) => deps.execute(executorDeps, p, adjustment, n),
    notify: deps.notify,
  };

  const record = await runOnce(runDeps, policy, nowSec);

  const runsDir = path.resolve("runs");
  await deps.mkdir(runsDir, { recursive: true });
  // ISO timestamps carry colons, which Windows filesystems reject; the
  // filename is sanitised, the recorded `startedAt` field is not.
  const fileName = `${record.startedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(runsDir, fileName);
  await deps.writeFile(filePath, JSON.stringify(toSerialisable(record), null, 2));
  deps.log(filePath);
  return undefined;
}

function realCliDeps(): CliDeps {
  return {
    readPolicy,
    now: () => Math.floor(Date.now() / 1000),
    buildReaderDeps,
    readFacts,
    buildExecutorDeps,
    execute: executeAdjustment,
    notify: notifyWebhook,
    mkdir,
    writeFile,
    readRuns,
    log: (message) => console.log(message),
    table: (rows) => console.table(rows),
  };
}

async function main(): Promise<void> {
  await runCli(realCliDeps(), process.argv.slice(2));
}

// Guards `main()` behind an entrypoint check: `node`/`tsx` sets
// `process.argv[1]` to the script actually invoked, so this only matches
// when this file is that script — never when it is merely imported (as
// every test in this repo, and any future consumer, does). Without this
// guard, importing this module for its exported `runCli`/`CliDeps` runs a
// real tick against `realCliDeps()`: with a readable policy path in
// `process.argv.slice(2)` and the four required env vars exported, that is a
// live, non-dry-run broadcast to Sepolia triggered by nothing more than an
// import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(reason(error));
    process.exitCode = 1;
  });
}
