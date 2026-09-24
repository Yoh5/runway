/**
 * Sizes the restore: reads the treasury's live balance and live stream rates,
 * then prints exactly how much ETH must be wrapped before `decide()` stops
 * holding and walks every stream back to its committed rate.
 *
 * `restore` is implemented and tested and has never fired on chain. The
 * submission says so. This is what turns the run that would change that into
 * a decision rather than a guess — the mirror of `plan-breach`, which sized
 * the shed that did fire, on 8 September 2026.
 *
 * This script only reads the chain and prints arithmetic. It never signs,
 * never simulates a write, never calls KeeperHub. The operator reads the
 * output, decides, and performs the wrap themselves.
 *
 *   node --env-file=.env --import tsx scripts/plan-restore.ts [policy.yaml] [--margin-hours=N]
 */

import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { SUPER_TOKEN_READ_ABI } from "../src/chain/abi.js";
import { readFacts, type ReaderDeps } from "../src/chain/reader.js";
import { loadPolicy } from "../src/policy/load.js";
import type { Policy } from "../src/policy/types.js";
import { planRestore, RestorePlanError } from "./lib/plan-restore.js";

/**
 * Two hours of committed outflow, wrapped on top of the bare threshold. The
 * balance drains every second — including while the wrap confirms and while
 * the operator gets to the tick — so a wrap sized to the exact boundary can
 * land one wei below it and decide `hold`, which proves nothing. Two hours is
 * cheap on a testnet and wide enough for a human pace.
 */
const DEFAULT_MARGIN_HOURS = 2;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new RestorePlanError(`${name} is not set`);
  return value;
}

function parseArgs(argv: string[]): { policyPath: string; marginHours: number } {
  const policyPath = argv.find((a) => !a.startsWith("--")) ?? "policies/treasury.sepolia.yaml";
  const flag = argv.find((a) => a.startsWith("--margin-hours="));
  const marginHours = flag ? Number(flag.slice("--margin-hours=".length)) : DEFAULT_MARGIN_HOURS;
  if (!Number.isInteger(marginHours) || marginHours < 0) {
    throw new RestorePlanError(
      `--margin-hours must be a whole number of hours, got ${JSON.stringify(flag)}`,
    );
  }
  return { policyPath, marginHours };
}

function eth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

function hours(sec: bigint): string {
  return (Number(sec) / 3600).toFixed(2);
}

async function main(): Promise<void> {
  const { policyPath, marginHours } = parseArgs(process.argv.slice(2));

  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const readerDeps: ReaderDeps = {
    client: {
      readContract: (args) =>
        client.readContract(args as unknown as Parameters<typeof client.readContract>[0]),
    },
    rpcUrl,
  };

  const policy: Policy = loadPolicy(await readFile(policyPath, "utf8"));
  const blockNumber = await client.getBlockNumber();
  const nowSec = Math.floor(Date.now() / 1000);

  console.log(`Ethereum Sepolia, block ${blockNumber}, read at ${new Date(nowSec * 1000).toISOString()}`);
  console.log(`policy: ${policyPath}`);
  console.log(
    `targetRunwaySec = ${policy.targetRunwaySec} (${policy.targetRunwaySec / 3600n}h), hysteresisSec = ${policy.hysteresisSec} (${policy.hysteresisSec / 3600n}h)`,
  );
  console.log("");

  const facts = await readFacts(readerDeps, policy, nowSec);

  // Read the balance again, raw. `readFacts` clamps a negative available
  // balance to zero on purpose -- a negative runway would read as plenty of
  // time -- but an insolvent treasury has a hole a wrap must refill before a
  // single wei counts toward the band, and sizing against the clamped number
  // would understate the wrap by exactly that hole.
  const [rawAvailableBalanceWei] = (await client.readContract({
    address: policy.token,
    abi: SUPER_TOKEN_READ_ABI,
    functionName: "realtimeBalanceOf",
    args: [policy.sender, BigInt(nowSec)],
  })) as readonly [bigint, bigint, bigint];

  const plan = planRestore({
    policy,
    currentAvailableBalanceWei: rawAvailableBalanceWei,
    currentStreamRatesWeiPerSec: facts.streams.map((s) => s.flowRateWeiPerSec),
    unlistedOutflowWeiPerSec: facts.unlistedOutflowWeiPerSec,
    nowSec,
    marginSec: BigInt(marginHours) * 3600n,
  });

  console.log("--- live facts ---");
  console.log(
    `availableBalance = ${rawAvailableBalanceWei} wei (${eth(rawAvailableBalanceWei)} ETHx)`,
  );
  if (plan.deficitWei > 0n) {
    console.log(
      `  !! INSOLVENT: the balance is ${plan.deficitWei} wei (${eth(plan.deficitWei)} ETHx) below zero.`,
    );
    console.log(
      "     Anyone may liquidate this treasury right now, closing every stream in one block and taking the locked deposit as the reward. The wrap below refills that hole first.",
    );
  }
  for (const [i, stream] of facts.streams.entries()) {
    const recipient = policy.recipients[i];
    console.log(
      `  ${recipient?.tier.padEnd(13)} rate = ${stream.flowRateWeiPerSec}  (committed ${recipient?.committedRateWeiPerSec}, floor ${recipient?.floorRateWeiPerSec})`,
    );
  }
  console.log("");

  console.log("--- arithmetic ---");
  console.log(
    `currentOutflowWeiPerSec = ${plan.currentOutflowWeiPerSec}  -> runway now ${plan.currentRunwaySec} sec (${hours(plan.currentRunwaySec)}h)`,
  );
  console.log(
    `committedOutflowWeiPerSec = ${plan.committedOutflowWeiPerSec}  -> runway at committed rates ${plan.runwayAtCommittedSec} sec (${hours(plan.runwayAtCommittedSec)}h)`,
  );
  console.log(
    "  -- the band is measured at the committed rates: the question is whether the treasury can afford what it agreed to pay, not what it is paying today.",
  );
  console.log(
    `restoreThresholdWei = committedOutflow * (target + hysteresis) = ${plan.committedOutflowWeiPerSec} * ${policy.targetRunwaySec + policy.hysteresisSec} = ${plan.restoreThresholdWei} wei (${eth(plan.restoreThresholdWei)} ETHx)`,
  );
  console.log("");

  if (plan.alreadyRestorable) {
    console.log("--- nothing to wrap ---");
    console.log("The treasury is already above the band; the next tick restores on its own.");
  } else {
    console.log(`--- to wrap (margin: ${marginHours}h of committed outflow) ---`);
    console.log(
      `wrapAmountWei = (restoreThresholdWei - availableBalance) + committedOutflow * margin = ${plan.wrapAmountWei} wei`,
    );
    console.log(`wrap ${plan.wrapAmountWei} wei (${eth(plan.wrapAmountWei)} ETH) into ETHx`);
    console.log(`resulting balance = ${plan.resultingBalanceWei} wei (${eth(plan.resultingBalanceWei)} ETHx)`);
  }
  console.log("");

  console.log("--- resulting decision (decide() run against that balance) ---");
  console.log(`kind: ${plan.resultingDecision.kind}`);
  console.log(`runwaySec: ${plan.resultingDecision.runwaySec}`);
  console.log(
    `escalation: ${plan.resultingDecision.escalation ? `${plan.resultingDecision.escalation.kind} -- ${plan.resultingDecision.escalation.detail}` : "none"}`,
  );
  for (const adjustment of plan.resultingDecision.adjustments) {
    console.log(
      `  ${adjustment.receiver}  ${adjustment.fromRateWeiPerSec} -> ${adjustment.toRateWeiPerSec}  (${adjustment.reason})`,
    );
  }
  console.log("");

  if (plan.resultingDecision.kind === "restore") {
    console.log(
      "Wrap that amount, then run the tick. Restore raises the most critical stream first -- the shed order reversed -- and never past the committed rate.",
    );
  } else {
    console.log(
      `This would decide ${plan.resultingDecision.kind}, not restore. Raise --margin-hours, or check whether a stream sits at rate zero: a closed stream cannot be reopened under this mandate.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
