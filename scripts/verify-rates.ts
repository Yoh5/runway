/**
 * Reads the live flow rate of every stream the policy names, straight off the
 * chain, and compares it against that recipient's committed rate and floor.
 *
 * This exists because a mined receipt and a chain read prove different things.
 * A receipt says a transaction was included. Only a read says the stream is
 * actually running at the rate the keeper decided. The evidence document
 * reports both, and this is where the second one comes from.
 *
 *   node --env-file=.env --import tsx scripts/verify-rates.ts
 */

import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { loadPolicy } from "../src/policy/load.js";
import { CFA_FORWARDER_ADDRESS, CFA_FORWARDER_READ_ABI } from "../src/chain/abi.js";

const POLICY_PATH = process.argv[2] ?? "policies/treasury.sepolia.yaml";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

async function main(): Promise<void> {
  const policy = loadPolicy(readFileSync(POLICY_PATH, "utf-8"));
  const client = createPublicClient({
    chain: sepolia,
    transport: http(requireEnv("SEPOLIA_RPC_URL")),
  });

  const blockNumber = await client.getBlockNumber();
  console.log(
    `Ethereum Sepolia, block ${blockNumber}, read at ${new Date().toISOString()}`
  );
  console.log(`policy: ${POLICY_PATH}`);
  console.log("");
  console.log("tier             live rate        committed        floor            at");
  console.log("-".repeat(78));

  for (const recipient of policy.recipients) {
    const info = (await client.readContract({
      address: CFA_FORWARDER_ADDRESS,
      abi: CFA_FORWARDER_READ_ABI,
      functionName: "getFlowInfo",
      args: [policy.token, policy.sender, recipient.address],
    })) as readonly [bigint, bigint, bigint, bigint];

    const live = info[1];
    // Where the live rate sits tells the reader what the keeper did without
    // needing the run record beside it.
    let position: string;
    if (live === recipient.committedRateWeiPerSec) {
      position = "committed rate";
    } else if (live === recipient.floorRateWeiPerSec) {
      position = "floor";
    } else if (live < recipient.floorRateWeiPerSec) {
      position = "BELOW FLOOR";
    } else {
      position = "between floor and committed";
    }

    console.log(
      recipient.tier.padEnd(16) +
        live.toString().padStart(15) +
        "  " +
        recipient.committedRateWeiPerSec.toString().padStart(15) +
        "  " +
        recipient.floorRateWeiPerSec.toString().padStart(15) +
        "  " +
        position
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
