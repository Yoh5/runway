import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { PlanError, type PlanInputs, planStreams } from "./lib/plan.js";
import {
  CFAV1_PPP_CONFIG_KEY,
  decodePPPConfig,
  ETHX_ADDRESS,
  GOVERNANCE_ADDRESS,
  GOVERNANCE_READ_ABI,
  HOST_ADDRESS,
  TREASURY_ADDRESS,
} from "./lib/superfluid.js";

/**
 * Fixed choices this deployment makes; everything else (the balance, the
 * liquidation period) is read live so the plan never goes stale.
 *
 * - 0.1 ETH gas reserve: five Sepolia signatures (wrap, three createFlow,
 *   one grant-flow-operator) cost a small fraction of this even at the
 *   40-105 gwei spikes KeeperHub measured (see docs/superpowers/specs/
 *   2026-09-06-runway-design.md, section 14).
 * - 25% margin above targetRunwayHours + hysteresisHours: keeps the first
 *   dry run unambiguously inside "hold" rather than riding the boundary.
 * - Tier weights 5:3:2 and floors 60% / 0% / 20%: distinct, descending
 *   rates with a non-zero discretionary floor (never zero -- see
 *   PlanError's message in scripts/lib/plan.ts for why).
 */
const GAS_RESERVE_WEI = 100_000_000_000_000_000n; // 0.1 ETH
const TARGET_RUNWAY_SEC = 168n * 3600n;
const HYSTERESIS_SEC = 24n * 3600n;
const MARGIN_PERCENT = 25n;
const TIER_WEIGHTS: readonly [bigint, bigint, bigint] = [5n, 3n, 2n];
const TIER_FLOOR_PERCENTS: readonly [bigint, bigint, bigint] = [60n, 0n, 20n];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new PlanError(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  const blockNumber = await client.getBlockNumber();
  const treasuryEthWei = await client.getBalance({ address: TREASURY_ADDRESS });

  const pppConfig = (await client.readContract({
    address: GOVERNANCE_ADDRESS,
    abi: GOVERNANCE_READ_ABI,
    functionName: "getConfigAsUint256",
    args: [HOST_ADDRESS, ETHX_ADDRESS, CFAV1_PPP_CONFIG_KEY],
  })) as bigint;
  const { liquidationPeriodSec } = decodePPPConfig(pppConfig);

  console.log(`Ethereum Sepolia, block ${blockNumber}, read at ${new Date().toISOString()}`);
  console.log(`treasury (${TREASURY_ADDRESS}) ETH balance = ${treasuryEthWei} wei`);
  console.log(`governance liquidation period (ETHx) = ${liquidationPeriodSec}s`);
  console.log("");

  const inputs: PlanInputs = {
    treasuryEthWei,
    gasReserveWei: GAS_RESERVE_WEI,
    targetRunwaySec: TARGET_RUNWAY_SEC,
    hysteresisSec: HYSTERESIS_SEC,
    liquidationPeriodSec,
    marginPercent: MARGIN_PERCENT,
    tierWeights: TIER_WEIGHTS,
    tierFloorPercents: TIER_FLOOR_PERCENTS,
  };

  console.log("--- inputs ---");
  console.log(`treasuryEthWei        = ${inputs.treasuryEthWei}`);
  console.log(`gasReserveWei         = ${inputs.gasReserveWei}  (kept unwrapped, for the five setup signatures)`);
  console.log(`targetRunwaySec       = ${inputs.targetRunwaySec}  (168h)`);
  console.log(`hysteresisSec         = ${inputs.hysteresisSec}  (24h)`);
  console.log(`liquidationPeriodSec  = ${inputs.liquidationPeriodSec}  (from governance PPPConfiguration, live)`);
  console.log(`marginPercent         = ${inputs.marginPercent}%  (above targetRunwaySec + hysteresisSec)`);
  console.log(`tierWeights           = [${inputs.tierWeights.join(", ")}]  (critical, standard, discretionary)`);
  console.log(`tierFloorPercents     = [${inputs.tierFloorPercents.join(", ")}]%`);
  console.log("");

  const plan = planStreams(inputs);

  console.log("--- arithmetic ---");
  const desiredRunwaySec = ((inputs.targetRunwaySec + inputs.hysteresisSec) * (100n + inputs.marginPercent)) / 100n;
  console.log(
    `desiredRunwaySec = (targetRunwaySec + hysteresisSec) * (100 + marginPercent) / 100` +
      ` = (${inputs.targetRunwaySec} + ${inputs.hysteresisSec}) * ${100n + inputs.marginPercent} / 100 = ${desiredRunwaySec}` +
      ` (${desiredRunwaySec / 3600n}h)`,
  );
  console.log(
    `wrapAmountWei = treasuryEthWei - gasReserveWei = ${inputs.treasuryEthWei} - ${inputs.gasReserveWei} = ${plan.wrapAmountWei}`,
  );
  console.log(
    `totalCommittedRateWeiPerSec = wrapAmountWei / (desiredRunwaySec + liquidationPeriodSec)` +
      ` = ${plan.wrapAmountWei} / (${desiredRunwaySec} + ${inputs.liquidationPeriodSec}) = ${plan.totalCommittedRateWeiPerSec} wei/sec`,
  );
  for (const s of plan.streams) {
    console.log(
      `  ${s.tier.padEnd(13)} committedRate = ${s.committedRateWeiPerSec} wei/sec` +
        `  floor = ${s.floorRateWeiPerSec} wei/sec` +
        `  buffer = rate * ${inputs.liquidationPeriodSec} = ${s.bufferWei} wei`,
    );
  }
  console.log(
    `totalBufferWei = sum(buffers) = ${plan.totalBufferWei} wei` +
      ` (${(Number(plan.totalBufferWei) / 1e18).toFixed(6)} ETH -- affordable against a ${(Number(plan.wrapAmountWei) / 1e18).toFixed(3)} ETH wrap)`,
  );
  console.log(
    `runwayAtCommittedSec = (wrapAmountWei - totalBufferWei) / totalCommittedRateWeiPerSec` +
      ` = (${plan.wrapAmountWei} - ${plan.totalBufferWei}) / ${plan.totalCommittedRateWeiPerSec} = ${plan.runwayAtCommittedSec}` +
      ` (${plan.runwayAtCommittedSec / 3600n}h)`,
  );
  const thresholdSec = inputs.targetRunwaySec + inputs.hysteresisSec;
  console.log(
    `check: runwayAtCommittedSec (${plan.runwayAtCommittedSec}) > targetRunwaySec + hysteresisSec (${thresholdSec})` +
      ` -> ${plan.runwayAtCommittedSec > thresholdSec}`,
  );
  console.log("");

  console.log("--- result ---");
  console.log(`wrap ${plan.wrapAmountWei} wei ETHx via upgradeByETH() (${(Number(plan.wrapAmountWei) / 1e18).toFixed(3)} ETH)`);
  for (const s of plan.streams) {
    console.log(`${s.tier}: committedRateWeiPerSec = "${s.committedRateWeiPerSec}", floorRateWeiPerSec = "${s.floorRateWeiPerSec}"`);
  }
  console.log(`flowRateAllowance for the mandate (sum of the three committed rates) = ${plan.totalCommittedRateWeiPerSec}`);

  if (plan.runwayAtCommittedSec <= thresholdSec) {
    throw new PlanError(
      `runwayAtCommittedSec (${plan.runwayAtCommittedSec}) does not clear targetRunwaySec + hysteresisSec (${thresholdSec}) -- refusing to hand out a plan the first dry run would not hold on`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
