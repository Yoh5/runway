import { keccak256, toBytes } from "viem";
import type { Address } from "../../src/policy/types.js";

/**
 * Addresses read from Superfluid's own network registry
 * (`superfluid-finance/protocol-monorepo`, `packages/metadata/networks.json`,
 * the `eth-sepolia` entry) on 2026-09-06, and re-asserted every time
 * `resolve-sepolia.ts` runs. `CFA_FORWARDER_ADDRESS` is not repeated here --
 * it already lives in `src/chain/abi.ts` and every script imports it from
 * there, so there is exactly one place it could go stale.
 */
export const ETHX_ADDRESS = "0x30a6933Ca9230361972E413a15dC8114c952414e" as Address;
export const HOST_ADDRESS = "0x109412E3C84f0539b43d39dB691B08c90f58dC7c" as Address;
export const GOVERNANCE_ADDRESS = "0x9539B21cC67844417E80aE168bc28c831E7Ed271" as Address;

/** Runway's own accounts. Neither script here ever holds a key for either. */
export const TREASURY_ADDRESS = "0xc4faEd0e400911e44fB75E63566BF8AAaF0F7776" as Address;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * ABI fragments not already published in `src/chain/abi.ts`, needed only by
 * the setup scripts to verify the chain before anything is written into a
 * policy file. Declared here rather than in `src/chain/abi.ts` because
 * nothing under `src/` reads them: the reader only ever needs the two
 * fragments already there.
 */
export const SUPER_TOKEN_SETUP_ABI = [
  {
    type: "function",
    name: "getUnderlyingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "tokenAddr", type: "address" }],
  },
  {
    type: "function",
    name: "getHost",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "host", type: "address" }],
  },
] as const;

export const GOVERNANCE_READ_ABI = [
  {
    type: "function",
    name: "getConfigAsUint256",
    stateMutability: "view",
    inputs: [
      { name: "host", type: "address" },
      { name: "superToken", type: "address" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [{ name: "value", type: "uint256" }],
  },
] as const;

/**
 * Config keys from `SuperfluidGovernanceConfigs`
 * (`packages/ethereum-contracts/contracts/interfaces/superfluid/Definitions.sol`
 * in `superfluid-finance/protocol-monorepo`, read 2026-09-06). Computed here
 * from the exact source strings rather than pasted as opaque `bytes32`
 * literals, so the provenance stays visible next to the value.
 */
export const CFAV1_PPP_CONFIG_KEY = keccak256(
  toBytes("org.superfluid-finance.agreements.ConstantFlowAgreement.v1.PPPConfiguration"),
);
export const SUPERTOKEN_MINIMUM_DEPOSIT_KEY = keccak256(
  toBytes("org.superfluid-finance.superfluid.superTokenMinimumDeposit"),
);

/**
 * Mirrors `SuperfluidGovernanceConfigs.decodePPPConfig` exactly: the two
 * uint32 periods are packed into one uint256 as
 * `(liquidationPeriod << 32) | patricianPeriod`.
 */
export function decodePPPConfig(pppConfig: bigint): {
  liquidationPeriodSec: bigint;
  patricianPeriodSec: bigint;
} {
  const mask = (1n << 32n) - 1n;
  return {
    liquidationPeriodSec: (pppConfig >> 32n) & mask,
    patricianPeriodSec: pppConfig & mask,
  };
}
