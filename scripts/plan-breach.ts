import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { readFacts, type ReaderDeps } from "../src/chain/reader.js";
import { loadPolicy } from "../src/policy/load.js";
import type { Policy } from "../src/policy/types.js";
import { BreachPlanError, planBreach } from "./lib/plan-breach.js";

/**
 * Sizes the demo breach: reads the treasury's live ETHx balance and live
 * stream rates, then prints exactly how far the balance must fall -- via
 * `downgradeToETH`, the honest way to produce a breach -- before `decide()`
 * stops holding, and how much further before its shed cannot be absorbed by
 * the three floors alone and must escalate.
 *
 * This script only reads the chain and prints arithmetic. It never signs,
 * never simulates a write, never calls KeeperHub's execute API. The human
 * partner reads this output, decides, and runs `downgradeToETH` themselves.
 *
 * Default target: 24 hours. Comfortably below `minRunwayHours` (72h, so the
 * breach itself is unambiguous even to someone glancing at a demo video) and
 * far inside the escalation boundary this deployment computes to ~69.7h of
 * runway (24h << 69.7h leaves wide margin against the balance draining
 * every second while a transaction confirms). The brief is explicit that the
 * target should default to one that escalates: a shed that succeeds
 * silently is indistinguishable from a keeper that did nothing, whereas the
 * escalation is the design refusing a silent breach. Pass
 * --target-runway-hours=<N> to land somewhere else instead -- N must still
 * be below minRunwayHours or the result would not breach at all.
 */
const DEFAULT_TARGET_RUNWAY_HOURS = 24;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new BreachPlanError(`${name} is not set`);
  return value;
}

function parseArgs(argv: string[]): { policyPath: string; targetRunwayHours: number } {
  const policyPath = argv.find((a) => !a.startsWith("--")) ?? "policies/treasury.sepolia.yaml";
  const flag = argv.find((a) => a.startsWith("--target-runway-hours="));
  const targetRunwayHours = flag ? Number(flag.slice("--target-runway-hours=".length)) : DEFAULT_TARGET_RUNWAY_HOURS;
  if (!Number.isInteger(targetRunwayHours) || targetRunwayHours <= 0) {
    throw new BreachPlanError(
      `--target-runway-hours must be a positive whole number of hours, got ${JSON.stringify(flag)}`,
    );
  }
  return { policyPath, targetRunwayHours };
}

function eth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

async function main(): Promise<void> {
  const { policyPath, targetRunwayHours } = parseArgs(process.argv.slice(2));
  const targetRunwaySecAfterUnwrap = BigInt(targetRunwayHours) * 3600n;

  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const readerDeps: ReaderDeps = {
    client: {
      readContract: (args) =>
        client.readContract(args as unknown as Parameters<typeof client.readContract>[0]),
    },
    rpcUrl,
  };

  const yamlText = await readFile(policyPath, "utf8");
  const policy: Policy = loadPolicy(yamlText);

  const blockNumber = await client.getBlockNumber();
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Ethereum Sepolia, block ${blockNumber}, read at ${new Date(nowSec * 1000).toISOString()}`);
  console.log(`policy: ${policyPath}`);
  console.log(`minRunwaySec = ${policy.minRunwaySec} (${policy.minRunwaySec / 3600n}h)`);
  console.log(`targetRunwaySec = ${policy.targetRunwaySec} (${policy.targetRunwaySec / 3600n}h)`);
  console.log("");

  const facts = await readFacts(readerDeps, policy, nowSec);
  console.log("--- live facts ---");
  console.log(`treasury (${policy.sender}) ETHx availableBalance = ${facts.availableBalanceWei} wei (${eth(facts.availableBalanceWei)} ETHx)`);
  for (const [i, s] of facts.streams.entries()) {
    const recipient = policy.recipients[i];
    console.log(`  ${recipient?.tier.padEnd(13)} ${s.receiver}  rate = ${s.flowRateWeiPerSec} wei/sec  (committed ${recipient?.committedRateWeiPerSec}, floor ${recipient?.floorRateWeiPerSec})`);
  }
  console.log(`unlistedOutflowWeiPerSec = ${facts.unlistedOutflowWeiPerSec}`);
  console.log("");

  const plan = planBreach({
    policy,
    currentAvailableBalanceWei: facts.availableBalanceWei,
    currentStreamRatesWeiPerSec: facts.streams.map((s) => s.flowRateWeiPerSec),
    unlistedOutflowWeiPerSec: facts.unlistedOutflowWeiPerSec,
    nowSec,
    targetRunwaySecAfterUnwrap,
  });

  console.log("--- arithmetic ---");
  console.log(
    `netOutflowWeiPerSec = sum(live stream rates) + unlistedOutflowWeiPerSec = ${plan.netOutflowWeiPerSec} wei/sec`,
  );
  console.log(
    `currentRunwaySec = availableBalanceWei / netOutflowWeiPerSec = ${facts.availableBalanceWei} / ${plan.netOutflowWeiPerSec} = ${plan.currentRunwaySec} (${(Number(plan.currentRunwaySec) / 3600).toFixed(2)}h)`,
  );
  console.log("");

  console.log(
    `breachThresholdWei = netOutflowWeiPerSec * minRunwaySec = ${plan.netOutflowWeiPerSec} * ${policy.minRunwaySec} = ${plan.breachThresholdWei} wei (${eth(plan.breachThresholdWei)} ETHx)`,
  );
  console.log("  -- the balance must fall strictly below this for decide() to stop holding.");

  const sumFloorsWeiPerSec = policy.recipients.reduce((sum, r) => sum + r.floorRateWeiPerSec, 0n);
  console.log(
    `escalationBoundaryWei = sum(floorRateWeiPerSec) * targetRunwaySec = ${sumFloorsWeiPerSec} * ${policy.targetRunwaySec} = ${plan.escalationBoundaryWei} wei (${eth(plan.escalationBoundaryWei)} ETHx)`,
  );
  console.log("  -- the balance must fall strictly below this for the three floors, even all reached, to fail to cover the shed.");
  const windowWei = plan.breachThresholdWei - plan.escalationBoundaryWei;
  console.log(
    `window (floors cover the shed without escalating) = breachThresholdWei - escalationBoundaryWei = ${windowWei} wei (${eth(windowWei)} ETHx wide)`,
  );
  console.log("");

  console.log(`--- target: land at ${targetRunwayHours}h of runway (--target-runway-hours=${targetRunwayHours}) ---`);
  console.log(
    `requiredBalanceWei = netOutflowWeiPerSec * targetRunwaySecAfterUnwrap = ${plan.netOutflowWeiPerSec} * ${targetRunwaySecAfterUnwrap} = ${plan.requiredBalanceWei} wei (${eth(plan.requiredBalanceWei)} ETHx)`,
  );
  console.log(
    `  clears breach: requiredBalanceWei (${plan.requiredBalanceWei}) < breachThresholdWei (${plan.breachThresholdWei}) -> ${plan.requiredBalanceWei < plan.breachThresholdWei}`,
  );
  console.log(
    `  clears escalation boundary: requiredBalanceWei (${plan.requiredBalanceWei}) < escalationBoundaryWei (${plan.escalationBoundaryWei}) -> ${plan.requiredBalanceWei < plan.escalationBoundaryWei}`,
  );
  console.log("");
  console.log(
    `unwrapAmountWei = currentAvailableBalanceWei - requiredBalanceWei = ${facts.availableBalanceWei} - ${plan.requiredBalanceWei} = ${plan.unwrapAmountWei} wei`,
  );
  console.log(`unwrap ${plan.unwrapAmountWei} wei (${eth(plan.unwrapAmountWei)} ETH) via downgradeToETH()`);
  console.log("");

  console.log("--- resulting decision (decide() run against the post-unwrap balance) ---");
  console.log(`kind: ${plan.resultingDecision.kind}`);
  console.log(`runwaySec: ${plan.resultingDecision.runwaySec}`);
  console.log(`breach: ${plan.resultingDecision.breach}`);
  console.log(
    `escalation: ${plan.resultingDecision.escalation ? `${plan.resultingDecision.escalation.kind} -- ${plan.resultingDecision.escalation.detail}` : "none"}`,
  );
  for (const status of plan.streamStatuses) {
    console.log(
      `  ${status.tier.padEnd(13)} ${status.address}  current ${status.currentRateWeiPerSec} -> ${status.touchedByShed ? "touched" : "untouched"}${status.atFloor ? " (at floor)" : ""}`,
    );
  }
  console.log("");

  if (plan.resultingDecision.escalation) {
    console.log(
      `This target escalates: even every floor reached, the shed cannot close the gap. That is the design refusing a silent breach, not a bug -- a shed that succeeds silently would be indistinguishable from a keeper that did nothing.`,
    );
  } else {
    console.log(
      `This target does NOT escalate: the three floors alone cover the shed. Pick a lower --target-runway-hours to demonstrate the escalation path instead.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
