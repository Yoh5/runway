/**
 * Checks, against the live KeeperHub deployment and the live chain, that every
 * assumption this integration rests on still holds.
 *
 * A passing test suite proves the code is consistent with itself. It says
 * nothing about an API that renamed a route last week, a mandate the treasury
 * revoked this morning, or an execution record that no longer resolves. This
 * is the part that rots without anyone touching the repository, so it is the
 * part worth running on a schedule.
 *
 * Every probe is read-only. The two POSTs carry no credentials and an empty
 * body -- one to the real action (which must refuse them) and one to an action
 * that does not exist (which must 404) -- so nothing here can move a rate or
 * spend gas.
 *
 *   node --env-file=.env --import tsx scripts/conformance.ts [policy.yaml]
 *
 * Exits non-zero if any check fails, so a scheduler can alert on it.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { CFA_FORWARDER_ADDRESS, CFA_FORWARDER_MANDATE_ABI } from "../src/chain/abi.js";
import {
  runConformance,
  type Check,
  type RecordedExecution,
} from "../src/keeperhub/conformance.js";
import { loadPolicy } from "../src/policy/load.js";
import type { Address } from "../src/policy/types.js";

const POLICY_PATH = process.argv[2] ?? "policies/treasury.sepolia.yaml";
const RUNS_DIR = "runs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * Every execution this repository recorded, with the hash recorded beside it.
 * These are the rows KeeperHub is asked to still resolve: the check is not
 * "does the API answer" but "does it answer with what we wrote down".
 */
function recordedExecutions(dir: string): RecordedExecution[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const found = new Map<string, string>();
  for (const entry of entries) {
    const record = JSON.parse(readFileSync(path.join(dir, entry), "utf-8")) as {
      outcomes?: { outcome?: { executionId?: string; transactionHash?: string } }[];
    };
    for (const { outcome } of record.outcomes ?? []) {
      if (outcome?.executionId && outcome.transactionHash) {
        found.set(outcome.executionId, outcome.transactionHash);
      }
    }
  }
  return [...found].map(([executionId, transactionHash]) => ({ executionId, transactionHash }));
}

function print(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const policy = loadPolicy(readFileSync(POLICY_PATH, "utf-8"));
  const client = createPublicClient({
    chain: sepolia,
    transport: http(requireEnv("SEPOLIA_RPC_URL")),
  });

  const executions = recordedExecutions(RUNS_DIR);
  const blockNumber = await client.getBlockNumber();
  console.log(`Ethereum Sepolia, block ${blockNumber}, read at ${new Date().toISOString()}`);
  console.log(`policy: ${POLICY_PATH}`);
  console.log(`recorded executions checked: ${executions.length}`);
  console.log("");

  const checks = await runConformance(
    {
      fetch: globalThis.fetch,
      baseUrl: requireEnv("KEEPERHUB_BASE_URL"),
      apiKey: requireEnv("KEEPERHUB_API_KEY"),
      flowOperator: requireEnv("KEEPERHUB_FLOW_OPERATOR_ADDRESS").toLowerCase() as Address,
      getCode: (address) => client.getCode({ address }),
      getFlowOperatorPermissions: async ({ token, sender, flowOperator }) => {
        const [permissions, flowrateAllowance] = await client.readContract({
          address: CFA_FORWARDER_ADDRESS,
          abi: CFA_FORWARDER_MANDATE_ABI,
          functionName: "getFlowOperatorPermissions",
          args: [token, sender, flowOperator],
        });
        return { permissions, flowrateAllowanceWeiPerSec: flowrateAllowance };
      },
    },
    policy,
    executions,
  );

  print(checks);

  const failed = checks.filter((c) => !c.ok).length;
  console.log("");
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
