import { load } from "js-yaml";
import { type Address, type Policy, type Recipient, type Tier, TIER_ORDER } from "./types.js";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const HOUR_SEC = 3600n;

function requireField(raw: Record<string, unknown>, name: string): unknown {
  const value = raw[name];
  if (value === undefined || value === null) {
    throw new PolicyError(`Missing required field: ${name}`);
  }
  return value;
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PolicyError(`${field} is not a 20-byte hex address: ${String(value)}`);
  }
  return value.toLowerCase() as Address;
}

function asBigint(value: unknown, field: string): bigint {
  if (typeof value !== "string") {
    throw new PolicyError(`${field} must be a quoted decimal string, got ${typeof value}`);
  }
  if (!/^\d+$/.test(value)) {
    throw new PolicyError(`${field} must be a non-negative integer: ${value}`);
  }
  return BigInt(value);
}

function asHoursSec(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PolicyError(`${field} must be a positive whole number of hours`);
  }
  return BigInt(value) * HOUR_SEC;
}

function asTier(value: unknown): Tier {
  if (typeof value !== "string" || !TIER_ORDER.includes(value as Tier)) {
    throw new PolicyError(
      `Unknown tier ${JSON.stringify(value)}; expected one of ${TIER_ORDER.join(", ")}`,
    );
  }
  return value as Tier;
}

export function loadPolicy(yamlText: string): Policy {
  const raw = load(yamlText);
  if (typeof raw !== "object" || raw === null) {
    throw new PolicyError("Policy document is not a mapping");
  }
  const doc = raw as Record<string, unknown>;

  if (requireField(doc, "version") !== 1) {
    throw new PolicyError(`Unsupported policy version: ${String(doc.version)}`);
  }

  const chainId = requireField(doc, "chainId");
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
    throw new PolicyError("chainId must be an integer");
  }

  const minRunwaySec = asHoursSec(requireField(doc, "minRunwayHours"), "minRunwayHours");
  const targetRunwaySec = asHoursSec(requireField(doc, "targetRunwayHours"), "targetRunwayHours");
  const hysteresisSec = asHoursSec(requireField(doc, "hysteresisHours"), "hysteresisHours");

  if (targetRunwaySec < minRunwaySec) {
    throw new PolicyError("targetRunwayHours must be at least minRunwayHours");
  }

  const rawRecipients = requireField(doc, "recipients");
  if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
    throw new PolicyError("recipients must be a non-empty list");
  }

  const seen = new Set<string>();
  const recipients: Recipient[] = rawRecipients.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new PolicyError(`recipients[${index}] is not a mapping`);
    }
    const r = entry as Record<string, unknown>;
    const address = asAddress(requireField(r, "address"), `recipients[${index}].address`);
    if (seen.has(address)) {
      throw new PolicyError(`Duplicate recipient address: ${address}`);
    }
    seen.add(address);

    const committedRateWeiPerSec = asBigint(
      requireField(r, "committedRateWeiPerSec"),
      `recipients[${index}].committedRateWeiPerSec`,
    );
    const floorRateWeiPerSec = asBigint(
      requireField(r, "floorRateWeiPerSec"),
      `recipients[${index}].floorRateWeiPerSec`,
    );
    if (floorRateWeiPerSec > committedRateWeiPerSec) {
      throw new PolicyError(
        `recipients[${index}]: floorRateWeiPerSec exceeds committedRateWeiPerSec`,
      );
    }

    const label = requireField(r, "label");
    if (typeof label !== "string" || label.length === 0) {
      throw new PolicyError(`recipients[${index}].label must be a non-empty string`);
    }

    return {
      address,
      label,
      tier: asTier(requireField(r, "tier")),
      committedRateWeiPerSec,
      floorRateWeiPerSec,
    };
  });

  const escalation = requireField(doc, "escalation") as Record<string, unknown>;
  const webhook = escalation.webhook;
  if (typeof webhook !== "string" || webhook.length === 0) {
    throw new PolicyError("escalation.webhook must be a non-empty string");
  }

  return {
    version: 1,
    chainId,
    token: asAddress(requireField(doc, "token"), "token"),
    sender: asAddress(requireField(doc, "sender"), "sender"),
    minRunwaySec,
    targetRunwaySec,
    hysteresisSec,
    recipients,
    escalation: { webhook },
  };
}
