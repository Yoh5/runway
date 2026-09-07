import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { CFA_FORWARDER_ADDRESS, CFA_FORWARDER_READ_ABI, SUPER_TOKEN_READ_ABI } from "../src/chain/abi.js";
import {
  CFAV1_PPP_CONFIG_KEY,
  decodePPPConfig,
  ETHX_ADDRESS,
  GOVERNANCE_ADDRESS,
  GOVERNANCE_READ_ABI,
  HOST_ADDRESS,
  SUPER_TOKEN_SETUP_ABI,
  SUPERTOKEN_MINIMUM_DEPOSIT_KEY,
  TREASURY_ADDRESS,
  ZERO_ADDRESS,
} from "./lib/superfluid.js";

/**
 * Every assertion below stops the script rather than letting a bad read
 * become a printed "fact": a zero address, a revert or a mismatch here means
 * the chain moved under us and every downstream number (the policy file, the
 * planner, the runbook) would be wrong.
 */
export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ResolveError(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  const blockNumber = await client.getBlockNumber();
  console.log(`Ethereum Sepolia (chainId 11155111), block ${blockNumber}, read at ${new Date().toISOString()}`);
  console.log("");

  // 1. ETHx must be a native-asset super token: getUnderlyingToken() has to
  // answer the zero address, which is exactly why setup wraps with the
  // payable upgradeByETH() rather than the upgrade(uint256) KeeperHub's own
  // `wrap` action calls -- there is no underlying ERC-20 to pull from.
  const underlying = await client.readContract({
    address: ETHX_ADDRESS,
    abi: SUPER_TOKEN_SETUP_ABI,
    functionName: "getUnderlyingToken",
    args: [],
  });
  console.log(`ETHx.getUnderlyingToken() = ${underlying}`);
  if (underlying.toLowerCase() !== ZERO_ADDRESS) {
    throw new ResolveError(
      `ETHx.getUnderlyingToken() returned ${underlying}, not the zero address -- ` +
        "this is not a native-asset super token; upgradeByETH() would be the wrong call",
    );
  }

  // 2. ETHx's host must match Superfluid's published Sepolia host.
  const host = await client.readContract({
    address: ETHX_ADDRESS,
    abi: SUPER_TOKEN_SETUP_ABI,
    functionName: "getHost",
    args: [],
  });
  console.log(`ETHx.getHost() = ${host}`);
  if (host.toLowerCase() !== HOST_ADDRESS.toLowerCase()) {
    throw new ResolveError(`ETHx.getHost() returned ${host}, expected ${HOST_ADDRESS}`);
  }

  // 3. CFAv1Forwarder answers with the arities src/chain/abi.ts declares. A
  // zero-flow pair (treasury -> treasury, which has never had a stream
  // created) proves the contract is live and the ABI matches without needing
  // any real stream to exist yet.
  const flowInfo = (await client.readContract({
    address: CFA_FORWARDER_ADDRESS,
    abi: CFA_FORWARDER_READ_ABI,
    functionName: "getFlowInfo",
    args: [ETHX_ADDRESS, TREASURY_ADDRESS, TREASURY_ADDRESS],
  })) as readonly [bigint, bigint, bigint, bigint];
  if (flowInfo.length !== 4) {
    throw new ResolveError(`getFlowInfo returned ${flowInfo.length} fields, expected 4`);
  }
  console.log(
    `CFAv1Forwarder.getFlowInfo(ETHx, treasury, treasury) = ` +
      `lastUpdated ${flowInfo[0]}, flowRate ${flowInfo[1]}, deposit ${flowInfo[2]}, owedDeposit ${flowInfo[3]}`,
  );

  const accountFlowrate = (await client.readContract({
    address: CFA_FORWARDER_ADDRESS,
    abi: CFA_FORWARDER_READ_ABI,
    functionName: "getAccountFlowrate",
    args: [ETHX_ADDRESS, TREASURY_ADDRESS],
  })) as bigint;
  console.log(`CFAv1Forwarder.getAccountFlowrate(ETHx, treasury) = ${accountFlowrate} wei/sec`);
  console.log("");

  // 4. Governance minimum deposit and the liquidation/patrician period, read
  // live -- not the mainnet numbers, and not trusted from a prior read.
  const minDeposit = (await client.readContract({
    address: GOVERNANCE_ADDRESS,
    abi: GOVERNANCE_READ_ABI,
    functionName: "getConfigAsUint256",
    args: [HOST_ADDRESS, ETHX_ADDRESS, SUPERTOKEN_MINIMUM_DEPOSIT_KEY],
  })) as bigint;
  console.log(`Governance.superTokenMinimumDeposit(ETHx) = ${minDeposit} wei`);

  const pppConfig = (await client.readContract({
    address: GOVERNANCE_ADDRESS,
    abi: GOVERNANCE_READ_ABI,
    functionName: "getConfigAsUint256",
    args: [HOST_ADDRESS, ETHX_ADDRESS, CFAV1_PPP_CONFIG_KEY],
  })) as bigint;
  const { liquidationPeriodSec, patricianPeriodSec } = decodePPPConfig(pppConfig);
  console.log(
    `Governance.PPPConfiguration(ETHx) = liquidationPeriod ${liquidationPeriodSec}s, patricianPeriod ${patricianPeriodSec}s`,
  );
  if (liquidationPeriodSec === 0n) {
    throw new ResolveError(
      "liquidation period read as zero -- refusing to size stream buffers against a zero window",
    );
  }
  console.log("");

  // 5. The treasury's ETH balance and its current ETHx balance.
  const ethBalance = await client.getBalance({ address: TREASURY_ADDRESS });
  console.log(`treasury (${TREASURY_ADDRESS}) ETH balance = ${ethBalance} wei`);

  const ethxBalance = (await client.readContract({
    address: ETHX_ADDRESS,
    abi: SUPER_TOKEN_READ_ABI,
    functionName: "realtimeBalanceOf",
    args: [TREASURY_ADDRESS, BigInt(Math.floor(Date.now() / 1000))],
  })) as readonly [bigint, bigint, bigint];
  console.log(
    `treasury ETHx realtimeBalanceOf = available ${ethxBalance[0]} wei, ` +
      `deposit ${ethxBalance[1]} wei, owedDeposit ${ethxBalance[2]} wei`,
  );
  console.log("");
  console.log(`resolve-sepolia: all assertions passed at block ${blockNumber}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
