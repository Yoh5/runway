export type Address = `0x${string}`;

export type Tier = "critical" | "standard" | "discretionary";

/** Reduction order. Restoration walks this in reverse. */
export const TIER_ORDER: readonly Tier[] = [
  "discretionary",
  "standard",
  "critical",
];

export type Recipient = {
  address: Address;
  label: string;
  tier: Tier;
  committedRateWeiPerSec: bigint;
  floorRateWeiPerSec: bigint;
};

export type Policy = {
  version: 1;
  chainId: number;
  token: Address;
  sender: Address;
  minRunwaySec: bigint;
  targetRunwaySec: bigint;
  hysteresisSec: bigint;
  recipients: Recipient[];
  escalation: { webhook: string };
};

export type Stream = { receiver: Address; flowRateWeiPerSec: bigint };

export type Facts = {
  nowSec: number;
  availableBalanceWei: bigint;
  depositWei: bigint;
  streams: Stream[];
};

export type AdjustmentReason = "budget-shed" | "restore-to-committed";

export type Adjustment = {
  receiver: Address;
  fromRateWeiPerSec: bigint;
  toRateWeiPerSec: bigint;
  reason: AdjustmentReason;
};

export type Escalation = {
  kind: "floors-exceed-budget";
  detail: string;
};

export type Decision = {
  kind: "hold" | "reduce" | "restore";
  runwaySec: bigint | null;
  breach: boolean;
  adjustments: Adjustment[];
  escalation: Escalation | null;
};
