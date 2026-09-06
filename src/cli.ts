import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { CFA_FORWARDER_ADDRESS } from "./chain/abi.js";
import { readFacts, type ReaderDeps } from "./chain/reader.js";
import { executeAdjustment, type ExecutorDeps, type SimulateFn } from "./keeperhub/execute.js";
import { decide } from "./policy/decide.js";
import { loadPolicy } from "./policy/load.js";
import type { Decision, Policy } from "./policy/types.js";
import { toSerialisable } from "./runner/record.js";
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printDecisionTable(decision: Decision): void {
  console.log(`decision: ${decision.kind}`);
  console.log(`runwaySec: ${decision.runwaySec ?? "n/a"}`);
  console.log(`breach: ${decision.breach}`);
  if (decision.escalation) {
    console.log(`escalation: ${decision.escalation.kind} — ${decision.escalation.detail}`);
  }
  if (decision.adjustments.length === 0) {
    console.log("adjustments: none");
    return;
  }
  console.table(
    decision.adjustments.map((a) => ({
      receiver: a.receiver,
      from: a.fromRateWeiPerSec.toString(),
      to: a.toRateWeiPerSec.toString(),
      reason: a.reason,
    })),
  );
}

async function readPolicy(policyPath: string): Promise<Policy> {
  const yamlText = await readFile(policyPath, "utf8");
  return loadPolicy(yamlText);
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
  };
}

function buildExecutorDeps(): ExecutorDeps {
  const apiKey = requireEnv("KEEPERHUB_API_KEY");
  const baseUrl = requireEnv("KEEPERHUB_BASE_URL");
  const flowOperator = requireEnv("KEEPERHUB_FLOW_OPERATOR_ADDRESS");
  const client = createPublicClient({ chain: sepolia, transport: http(requireEnv("SEPOLIA_RPC_URL")) });

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
      return { reverted: true, reason: reason(error) };
    }
  };

  return {
    fetch: globalThis.fetch,
    baseUrl,
    apiKey,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const policyPath = args.find((a) => !a.startsWith("--"));
  if (!policyPath) {
    console.error("usage: cli.ts <policy.yaml> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const policy = await readPolicy(policyPath);
  const nowSec = Math.floor(Date.now() / 1000);

  if (dryRun) {
    // Reads and decides but constructs no executor at all, so this path
    // cannot write to the chain even if `decide` returned adjustments.
    const readerDeps = buildReaderDeps();
    const facts = await readFacts(readerDeps, policy, nowSec);
    const decision = decide(facts, policy);
    printDecisionTable(decision);
    return;
  }

  const readerDeps = buildReaderDeps();
  const executorDeps = buildExecutorDeps();
  const deps: RunDeps = {
    readFacts: (p, n) => readFacts(readerDeps, p, n),
    execute: (p, adjustment, n) => executeAdjustment(executorDeps, p, adjustment, n),
    notify: notifyWebhook,
  };

  const record = await runOnce(deps, policy, nowSec);

  const runsDir = path.resolve("runs");
  await mkdir(runsDir, { recursive: true });
  // ISO timestamps carry colons, which Windows filesystems reject; the
  // filename is sanitised, the recorded `startedAt` field is not.
  const fileName = `${record.startedAt.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(runsDir, fileName);
  await writeFile(filePath, JSON.stringify(toSerialisable(record), null, 2));
  console.log(filePath);
}

main().catch((error: unknown) => {
  console.error(reason(error));
  process.exitCode = 1;
});
