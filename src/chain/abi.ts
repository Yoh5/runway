/**
 * `realtimeBalanceOf` is not in KeeperHub's own SuperToken ABI, so it is
 * declared here. `balanceOf` alone cannot answer the question: it does not
 * return the deposit, and the deposit is what a liquidator takes.
 */
export const SUPER_TOKEN_READ_ABI = [
  {
    type: "function",
    name: "realtimeBalanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
    outputs: [
      { name: "availableBalance", type: "int256" },
      { name: "deposit", type: "uint256" },
      { name: "owedDeposit", type: "uint256" },
    ],
  },
] as const;

export const CFA_FORWARDER_READ_ABI = [
  {
    type: "function",
    name: "getFlowInfo",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "sender", type: "address" },
      { name: "receiver", type: "address" },
    ],
    outputs: [
      { name: "lastUpdated", type: "uint256" },
      { name: "flowRate", type: "int96" },
      { name: "deposit", type: "uint256" },
      { name: "owedDeposit", type: "uint256" },
    ],
  },
] as const;

/** Superfluid pins both forwarders to one address on every chain it supports. */
export const CFA_FORWARDER_ADDRESS = "0xcfA132E353cB4E398080B9700609bb008eceB125" as const;
