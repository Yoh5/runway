# Runway Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a keeper that watches a Superfluid treasury's runway, decides which streams to throttle when the budget runs short, and executes each change through KeeperHub under a bounded on-chain mandate — ending in one verified Sepolia transaction.

**Architecture:** Four units with one responsibility each. `reader` turns chain state into facts over plain RPC. `policy` is a pure function from facts to a decision, with no I/O and no clock. `executor` posts each decided adjustment to KeeperHub's direct-execution API and verifies the receipt. `runner` wires them on a cadence and records every run. All judgment lives in `policy`, which touches nothing; all side effects live in `executor`, which decides nothing.

**Tech Stack:** TypeScript, Node 22, pnpm, viem (chain reads), Vitest (tests), fast-check (property tests), Biome (lint/format), js-yaml (policy documents).

**Spec:** `docs/superpowers/specs/2026-09-06-runway-design.md`

## Global Constraints

- Node 22, pnpm, TypeScript strict mode. `"type": "module"`.
- Every **quantity** — rate, balance, duration — is `bigint`. Never `number`, never float, because a wei value past 2^53 silently loses precision as a double. **Identifiers and counters are not quantities** and stay `number`: `Policy.version`, `Policy.chainId` and `Facts.nowSec` are the only numbers in a domain type. (An earlier wording of this constraint named `Facts.nowSec` alone, which read as forbidding `chainId: number` while the specified type in Task 1 required it. The rule is about precision, not about the word `number`.)
- `policy` imports nothing from `reader`, `executor` or `runner`, and performs no I/O.
- Reduction tier order is fixed: `discretionary`, then `standard`, then `critical`. Restoration is the reverse.
- Permissions bitmap on the mandate is **6** (`update | delete`), never 7.
- KeeperHub action type: `superfluid/update-flow`. Request body fields: `chainId`, `token`, `sender`, `receiver`, `flowRate`, `userData`.
- KeeperHub auth: `Authorization: Bearer kh_...`, needs scope `mcp:write` to broadcast. Rate limit 60 requests/minute.
- Every write is simulated first — **locally, with viem `simulateContract` against our own RPC, never with KeeperHub's `simulate` flag.** The protocol-action route does not implement that flag (verified: `simulate` appears in `app/api/execute/{transfer,contract-call,check-and-execute}/route.ts` and in `_lib/simulate-flag.ts`, and nowhere in the catch-all `[...slug]/route.ts` that serves protocol actions). Sending `"simulate": true` there is an ignored unknown field, so the "simulation" would broadcast a real transaction and the broadcast that followed would send a second one.
- Idempotency keys replay for 24 hours only, so every key carries a time bucket.
- **A protocol write is synchronous.** The route broadcasts, waits, and re-verifies the receipt against the chain before answering (`completeExecution`, KEEP-966: *"independently re-verifies the claimed transaction against the chain — its returned outcome, not `result.success`, is authoritative"*). So `success: true` with a `transactionHash` already means the receipt was checked on chain. There is no 202, and the response carries no `executionId`, so there is nothing to poll: the `receipts[].verified` flow documented for `/transfer` does not apply to this route.
- **Secrets:** no secret value is ever pasted into the conversation, written into a file that is committed, or read aloud by a script. Scripts that check configuration print presence booleans only. `.env` is gitignored; `.env.example` carries names with empty values.
- No count produced by a run is written into a document unless a test reads it back off the source.

---

### Task 1: Scaffold and the policy document

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.jsonc`, `vitest.config.ts`, `.env.example`
- Create: `src/policy/types.ts`
- Create: `src/policy/load.ts`
- Create: `policies/example.sepolia.yaml`
- Test: `tests/policy/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Tier`, `Recipient`, `Policy`, `Stream`, `Facts`, `Adjustment`, `Decision` from `src/policy/types.ts`; `loadPolicy(yamlText: string): Policy` from `src/policy/load.ts` (throws `PolicyError` on invalid input).

- [ ] **Step 1: Initialise the project**

```bash
cd runway
pnpm init
pnpm add viem js-yaml
pnpm add -D typescript @types/node vitest fast-check @biomejs/biome @types/js-yaml
```

Then set `package.json` scripts and module type:

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "biome check .",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
```

`.env.example` — names only, no values:

```
KEEPERHUB_API_KEY=
KEEPERHUB_BASE_URL=https://app.keeperhub.com
SEPOLIA_RPC_URL=
```

- [ ] **Step 2: Write the domain types**

`src/policy/types.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing loader tests**

`tests/policy/load.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadPolicy, PolicyError } from "../../src/policy/load.js";

const VALID = `
version: 1
chainId: 11155111
token: "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
sender: "0xBbBbBBBbbBBBbbBBbbBbbbBBbBbbbbBbBBbBBbB1"
minRunwayHours: 72
targetRunwayHours: 168
hysteresisHours: 24
recipients:
  - address: "0xCcCCCcCCCCcCCCCCCcCcCccCcCCCcCcccccCcCc1"
    label: "Lead engineer"
    tier: critical
    committedRateWeiPerSec: "1000"
    floorRateWeiPerSec: "600"
escalation:
  webhook: "https://example.invalid/hook"
`;

describe("loadPolicy", () => {
  it("converts hours to seconds so the engine never sees an hour", () => {
    const policy = loadPolicy(VALID);
    expect(policy.minRunwaySec).toBe(72n * 3600n);
    expect(policy.targetRunwaySec).toBe(168n * 3600n);
    expect(policy.hysteresisSec).toBe(24n * 3600n);
  });

  it("parses rates as bigint, never number", () => {
    const recipient = loadPolicy(VALID).recipients[0];
    expect(recipient?.committedRateWeiPerSec).toBe(1000n);
    expect(recipient?.floorRateWeiPerSec).toBe(600n);
  });

  it("lowercases every address so comparisons are total", () => {
    const policy = loadPolicy(VALID);
    expect(policy.token).toBe(policy.token.toLowerCase());
    expect(policy.recipients[0]?.address).toBe(
      policy.recipients[0]?.address.toLowerCase(),
    );
  });

  it("rejects a floor above its committed rate", () => {
    const bad = VALID.replace('floorRateWeiPerSec: "600"', 'floorRateWeiPerSec: "1001"');
    expect(() => loadPolicy(bad)).toThrow(PolicyError);
  });

  it("rejects a target runway below the minimum", () => {
    const bad = VALID.replace("targetRunwayHours: 168", "targetRunwayHours: 24");
    expect(() => loadPolicy(bad)).toThrow(/target/i);
  });

  it("rejects a duplicated recipient address", () => {
    const bad = `${VALID}  - address: "0xCcCCCcCCCCcCCCCCCcCcCccCcCCCcCcccccCcCc1"
    label: "Duplicate"
    tier: standard
    committedRateWeiPerSec: "10"
    floorRateWeiPerSec: "0"
`;
    expect(() => loadPolicy(bad)).toThrow(/duplicate/i);
  });

  it("rejects an unknown tier", () => {
    const bad = VALID.replace("tier: critical", "tier: vip");
    expect(() => loadPolicy(bad)).toThrow(/tier/i);
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `pnpm test tests/policy/load.test.ts`
Expected: FAIL — cannot resolve `../../src/policy/load.js`.

- [ ] **Step 5: Implement the loader**

`src/policy/load.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test tests/policy/load.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the example policy**

`policies/example.sepolia.yaml` — the shape from the spec, with addresses left as
placeholders that the Task 9 setup script fills in. Every value is a quoted string for
rates and a plain integer for hours.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json biome.jsonc vitest.config.ts .env.example src tests policies
git commit -m "feat(policy): domain types and validated policy loader"
```

---

### Task 2: The decision engine — hold and reduce

**Files:**
- Create: `src/policy/decide.ts`
- Test: `tests/policy/decide-reduce.test.ts`

**Interfaces:**
- Consumes: every type from `src/policy/types.ts`.
- Produces: `decide(facts: Facts, policy: Policy): Decision`.

- [ ] **Step 1: Write the failing tests**

`tests/policy/decide-reduce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import type { Address, Facts, Policy } from "../../src/policy/types.js";

const CRIT = "0x1111111111111111111111111111111111111111" as Address;
const STD = "0x2222222222222222222222222222222222222222" as Address;
const DISC = "0x3333333333333333333333333333333333333333" as Address;

/**
 * Small round numbers so every expectation below can be derived by hand.
 * `over` exists because one case needs a different target runway: with a
 * 200s target no balance can both breach the 100s minimum and leave a shed
 * small enough for the discretionary tier to absorb alone.
 */
function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [
      { address: CRIT, label: "crit", tier: "critical", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 80n },
      { address: STD, label: "std", tier: "standard", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 50n },
      { address: DISC, label: "disc", tier: "discretionary", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
    ...over,
  };
}

function facts(balance: bigint, rates: [bigint, bigint, bigint]): Facts {
  return {
    nowSec: 1_700_000_000,
    availableBalanceWei: balance,
    depositWei: 0n,
    streams: [
      { receiver: CRIT, flowRateWeiPerSec: rates[0] },
      { receiver: STD, flowRateWeiPerSec: rates[1] },
      { receiver: DISC, flowRateWeiPerSec: rates[2] },
    ],
  };
}

describe("decide — hold", () => {
  it("holds when runway is at or above the minimum", () => {
    // 300 wei/sec outflow, 30000 balance -> 100s runway, exactly the minimum.
    const d = decide(facts(30_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.breach).toBe(false);
    expect(d.adjustments).toEqual([]);
    expect(d.runwaySec).toBe(100n);
  });

  it("reports a null runway when nothing is flowing", () => {
    const d = decide(facts(30_000n, [0n, 0n, 0n]), policy());
    expect(d.runwaySec).toBeNull();
    expect(d.kind).toBe("hold");
  });
});

describe("decide — reduce", () => {
  it("sheds from the discretionary tier first", () => {
    // 300/sec, balance 15000 -> runway 50s, below the 100s minimum.
    // budget = 15000 / 200 = 75/sec. Need to shed 225/sec.
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("reduce");
    expect(d.breach).toBe(true);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(0n);
  });

  it("never sends a stream below its floor", () => {
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    const floors = new Map([[CRIT, 80n], [STD, 50n], [DISC, 0n]]);
    for (const a of d.adjustments) {
      expect(a.toRateWeiPerSec).toBeGreaterThanOrEqual(floors.get(a.receiver) ?? 0n);
    }
  });

  it("escalates when every floor together still exceeds the budget, and still applies the cuts", () => {
    // budget = 15000/200 = 75/sec, floors sum to 130/sec.
    const d = decide(facts(15_000n, [100n, 100n, 100n]), policy());
    expect(d.escalation?.kind).toBe("floors-exceed-budget");
    expect(d.adjustments.length).toBeGreaterThan(0);
  });

  it("touches a higher tier only once every lower tier sits at its floor", () => {
    // A 200s target cannot produce this case: breaching the 100s minimum needs
    // balance < 30000, while a shed small enough for one tier needs >= 40000.
    // With a 120s target: runway = 29000/300 = 96s, under the minimum.
    // budget = 29000/120 = 241/sec, so the shed is 300 - 241 = 59/sec, which
    // the discretionary stream absorbs alone: 100 - 59 = 41.
    const d = decide(facts(29_000n, [100n, 100n, 100n]), policy({ targetRunwaySec: 120n }));
    expect(d.kind).toBe("reduce");
    expect(d.adjustments).toHaveLength(1);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(41n);
    expect(d.escalation).toBeNull();
  });

  it("emits nothing for a stream that is already where the shed would leave it", () => {
    // Discretionary already at 0, its floor. Outflow 200/sec on 15000 is a
    // 75s runway, under the minimum. budget = 15000/200 = 75/sec, so 125/sec
    // must go: standard down to its 50 floor, then critical takes 20 more and
    // stops at 80. Discretionary has nothing left to give and must produce no
    // adjustment at all — a write that changes nothing still costs gas.
    const d = decide(facts(15_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("reduce");
    expect(d.adjustments.map((a) => a.receiver)).toEqual([STD, CRIT]);
    expect(d.adjustments.map((a) => a.toRateWeiPerSec)).toEqual([50n, 80n]);
    expect(d.adjustments.every((a) => a.fromRateWeiPerSec !== a.toRateWeiPerSec)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test tests/policy/decide-reduce.test.ts`
Expected: FAIL — cannot resolve `../../src/policy/decide.js`.

- [ ] **Step 3: Implement `decide`, hold and reduce paths only**

`src/policy/decide.ts`:

```ts
import {
  type Adjustment,
  type Decision,
  type Escalation,
  type Facts,
  type Policy,
  type Recipient,
  TIER_ORDER,
} from "./types.js";

function indexRecipients(policy: Policy): Map<string, Recipient> {
  return new Map(policy.recipients.map((r) => [r.address, r]));
}

/**
 * Streams the policy knows about, in the order the shed walks them: tier
 * first, then descending rate, then address. Address is the final key so the
 * order is total and two runs on identical facts cannot disagree.
 */
function shedOrder(facts: Facts, policy: Policy): { recipient: Recipient; rate: bigint }[] {
  const byAddress = indexRecipients(policy);
  const known = facts.streams
    .map((s) => {
      const recipient = byAddress.get(s.receiver);
      return recipient ? { recipient, rate: s.flowRateWeiPerSec } : null;
    })
    .filter((e): e is { recipient: Recipient; rate: bigint } => e !== null);

  return known.sort((a, b) => {
    const tierDelta =
      TIER_ORDER.indexOf(a.recipient.tier) - TIER_ORDER.indexOf(b.recipient.tier);
    if (tierDelta !== 0) return tierDelta;
    if (a.rate !== b.rate) return a.rate > b.rate ? -1 : 1;
    return a.recipient.address < b.recipient.address ? -1 : 1;
  });
}

export function decide(facts: Facts, policy: Policy): Decision {
  const ordered = shedOrder(facts, policy);
  const netOutflow = ordered.reduce((sum, e) => sum + e.rate, 0n);

  if (netOutflow === 0n) {
    return { kind: "hold", runwaySec: null, breach: false, adjustments: [], escalation: null };
  }

  const runwaySec = facts.availableBalanceWei / netOutflow;
  if (runwaySec >= policy.minRunwaySec) {
    return { kind: "hold", runwaySec, breach: false, adjustments: [], escalation: null };
  }

  const budget = facts.availableBalanceWei / policy.targetRunwaySec;
  let need = netOutflow - budget;
  const adjustments: Adjustment[] = [];

  for (const { recipient, rate } of ordered) {
    if (need <= 0n) break;
    const reducible = rate > recipient.floorRateWeiPerSec ? rate - recipient.floorRateWeiPerSec : 0n;
    if (reducible === 0n) continue;
    const take = reducible < need ? reducible : need;
    adjustments.push({
      receiver: recipient.address,
      fromRateWeiPerSec: rate,
      toRateWeiPerSec: rate - take,
      reason: "budget-shed",
    });
    need -= take;
  }

  const escalation: Escalation | null =
    need > 0n
      ? {
          kind: "floors-exceed-budget",
          detail: `${need} wei/sec above budget after every floor was reached`,
        }
      : null;

  return { kind: "reduce", runwaySec, breach: true, adjustments, escalation };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm test tests/policy/decide-reduce.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/decide.ts tests/policy/decide-reduce.test.ts
git commit -m "feat(policy): runway calculation, hold and tiered shed"
```

---

### Task 3: The decision engine — restore and hysteresis

**Files:**
- Modify: `src/policy/decide.ts`
- Test: `tests/policy/decide-restore.test.ts`

**Interfaces:**
- Consumes: `decide` from Task 2.
- Produces: no new exports. `decide` gains the `restore` branch.

- [ ] **Step 1: Write the failing tests**

`tests/policy/decide-restore.test.ts` reuses the same `policy()` and `facts()` helpers
as Task 2 — copy them into this file rather than importing across test files, so each
suite reads on its own.

```ts
describe("decide — restore", () => {
  it("holds while the balance sits inside the hysteresis band", () => {
    // Committed outflow 300/sec. target + hysteresis = 250s -> needs 75000.
    // 60000 clears the 100s minimum at the degraded rate but not the band.
    const d = decide(facts(60_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.adjustments).toEqual([]);
  });

  it("restores toward committed rates once above the band", () => {
    const d = decide(facts(75_000n, [100n, 100n, 0n]), policy());
    expect(d.kind).toBe("restore");
    expect(d.breach).toBe(false);
    expect(d.adjustments).toHaveLength(1);
    expect(d.adjustments[0]?.receiver).toBe(DISC);
    expect(d.adjustments[0]?.toRateWeiPerSec).toBe(100n);
    expect(d.adjustments[0]?.reason).toBe("restore-to-committed");
  });

  it("restores critical before discretionary", () => {
    const d = decide(facts(75_000n, [0n, 0n, 0n]), policy());
    expect(d.adjustments.map((a) => a.receiver)).toEqual([CRIT, STD, DISC]);
  });

  it("holds when every stream already runs at its committed rate", () => {
    const d = decide(facts(75_000n, [100n, 100n, 100n]), policy());
    expect(d.kind).toBe("hold");
    expect(d.adjustments).toEqual([]);
  });

  it("never restores above the committed rate", () => {
    const overpaying = facts(75_000n, [150n, 100n, 100n]), p = policy();
    const d = decide(overpaying, p);
    for (const a of d.adjustments) {
      const committed = p.recipients.find((r) => r.address === a.receiver)?.committedRateWeiPerSec;
      expect(a.toRateWeiPerSec).toBeLessThanOrEqual(committed ?? 0n);
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test tests/policy/decide-restore.test.ts`
Expected: FAIL — every restore case returns `kind: "hold"` with no adjustments.

- [ ] **Step 3: Implement the restore branch**

Replace **both** early `hold` returns in `decide` with a call to `considerRestore`: the
`netOutflow === 0n` branch (passing `null` as the runway) and the
`runwaySec >= policy.minRunwaySec` branch.

Routing the zero-outflow case here is the point of this task, not a detail. A treasury
whose streams were all closed by an earlier shed has zero outflow and infinite runway,
and it is exactly the account that should resume paying once money arrives. Returning
`hold` there strands payroll off permanently — the one failure this project must not
ship. The spec says the same in §6: *if runwaySec is null or runwaySec >= minRunwaySec,
consider restoration.*

Add:

```ts
function considerRestore(
  facts: Facts,
  policy: Policy,
  runwaySec: bigint | null,
): Decision {
  const hold: Decision = {
    kind: "hold",
    runwaySec,
    breach: false,
    adjustments: [],
    escalation: null,
  };

  const committedOutflow = policy.recipients.reduce(
    (sum, r) => sum + r.committedRateWeiPerSec,
    0n,
  );
  if (committedOutflow === 0n) return hold;

  // The band is measured at committed rates, not at today's degraded rates:
  // the question is whether the treasury can afford what it originally agreed
  // to pay, not whether it can afford what it is currently paying.
  const runwayAtCommitted = facts.availableBalanceWei / committedOutflow;
  if (runwayAtCommitted < policy.targetRunwaySec + policy.hysteresisSec) return hold;

  const currentRate = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
  const restoreOrder = [...policy.recipients].sort((a, b) => {
    const tierDelta = TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier);
    if (tierDelta !== 0) return tierDelta;
    return a.address < b.address ? -1 : 1;
  });

  const adjustments: Adjustment[] = [];
  for (const recipient of restoreOrder) {
    const rate = currentRate.get(recipient.address) ?? 0n;
    if (rate === recipient.committedRateWeiPerSec) continue;
    adjustments.push({
      receiver: recipient.address,
      fromRateWeiPerSec: rate,
      toRateWeiPerSec: recipient.committedRateWeiPerSec,
      reason: "restore-to-committed",
    });
  }

  if (adjustments.length === 0) return hold;
  return { kind: "restore", runwaySec, breach: false, adjustments, escalation: null };
}
```

Note that a stream running *above* its committed rate is corrected downward by this same
branch: `toRateWeiPerSec` is always `committedRateWeiPerSec`, so invariant 2 holds by
construction rather than by a check.

- [ ] **Step 4: Run the whole policy suite**

Run: `pnpm test tests/policy`
Expected: PASS, all Task 1, 2 and 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy/decide.ts tests/policy/decide-restore.test.ts
git commit -m "feat(policy): restoration with a hysteresis band"
```

---

### Task 4: Invariants as property tests

**Files:**
- Test: `tests/policy/invariants.test.ts`

**Interfaces:**
- Consumes: `decide`, all types.
- Produces: nothing. This task adds confidence, not surface.

- [ ] **Step 1: Write the property tests**

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import { type Address, type Facts, type Policy, TIER_ORDER } from "../../src/policy/types.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const rate = fc.bigInt({ min: 0n, max: 10n ** 12n });

const scenario = fc
  .record({
    count: fc.integer({ min: 1, max: 8 }),
    balance: fc.bigInt({ min: 0n, max: 10n ** 24n }),
    minHours: fc.integer({ min: 1, max: 200 }),
    extraHours: fc.integer({ min: 0, max: 500 }),
    hystHours: fc.integer({ min: 1, max: 100 }),
    seed: fc.integer({ min: 0, max: 10_000 }),
  })
  .chain((base) =>
    fc
      .record({
        committed: fc.array(rate, { minLength: base.count, maxLength: base.count }),
        floorFraction: fc.array(fc.integer({ min: 0, max: 100 }), {
          minLength: base.count,
          maxLength: base.count,
        }),
        current: fc.array(rate, { minLength: base.count, maxLength: base.count }),
        tiers: fc.array(fc.constantFrom(...TIER_ORDER), {
          minLength: base.count,
          maxLength: base.count,
        }),
      })
      .map(({ committed, floorFraction, current, tiers }) => {
        const policy: Policy = {
          version: 1,
          chainId: 11155111,
          token: address(1),
          sender: address(2),
          minRunwaySec: BigInt(base.minHours) * 3600n,
          targetRunwaySec: BigInt(base.minHours + base.extraHours) * 3600n,
          hysteresisSec: BigInt(base.hystHours) * 3600n,
          recipients: committed.map((c, i) => ({
            address: address(100 + i),
            label: `r${i}`,
            tier: tiers[i] ?? "standard",
            committedRateWeiPerSec: c,
            floorRateWeiPerSec: (c * BigInt(floorFraction[i] ?? 0)) / 100n,
          })),
          escalation: { webhook: "https://example.invalid/hook" },
        };
        const facts: Facts = {
          nowSec: 1_700_000_000,
          availableBalanceWei: base.balance,
          depositWei: 0n,
          streams: committed.map((c, i) => ({
            receiver: address(100 + i),
            // Current rate is capped at committed: the chain cannot hold a
            // stream the treasury never opened.
            flowRateWeiPerSec: (current[i] ?? 0n) > c ? c : (current[i] ?? 0n),
          })),
        };
        return { policy, facts };
      }),
  );

describe("policy invariants", () => {
  it("1: never below a floor", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        for (const a of d.adjustments) {
          const r = policy.recipients.find((x) => x.address === a.receiver);
          expect(a.toRateWeiPerSec >= (r?.floorRateWeiPerSec ?? 0n)).toBe(true);
        }
      }),
    );
  });

  it("2: never above the committed rate", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        for (const a of d.adjustments) {
          const r = policy.recipients.find((x) => x.address === a.receiver);
          expect(a.toRateWeiPerSec <= (r?.committedRateWeiPerSec ?? 0n)).toBe(true);
        }
      }),
    );
  });

  it("3: after a reduce, the RESULTING total outflow fits the budget or an escalation is present", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        if (d.kind !== "reduce") return;
        const after = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
        for (const a of d.adjustments) after.set(a.receiver, a.toRateWeiPerSec);
        const total = [...after.values()].reduce((sum, r) => sum + r, 0n);
        const budget = facts.availableBalanceWei / policy.targetRunwaySec;
        expect(total <= budget || d.escalation !== null).toBe(true);
      }),
    );
  });

  it("4: a tier is touched only once every lower tier sits at its floor", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        if (d.kind !== "reduce") return;
        const after = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
        for (const a of d.adjustments) after.set(a.receiver, a.toRateWeiPerSec);
        for (const a of d.adjustments) {
          const touched = policy.recipients.find((x) => x.address === a.receiver);
          if (!touched) continue;
          const touchedIdx = TIER_ORDER.indexOf(touched.tier);
          for (const other of policy.recipients) {
            if (TIER_ORDER.indexOf(other.tier) >= touchedIdx) continue;
            expect((after.get(other.address) ?? 0n) <= other.floorRateWeiPerSec).toBe(true);
          }
        }
      }),
    );
  });

  it("5: identical inputs produce identical decisions", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const a = decide(facts, policy);
        const b = decide(facts, policy);
        expect(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
          JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        );
      }),
    );
  });

  it("6: no adjustment is ever a no-op write", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        for (const a of d.adjustments) {
          expect(a.fromRateWeiPerSec).not.toBe(a.toRateWeiPerSec);
        }
        if (d.kind === "hold") expect(d.adjustments).toEqual([]);
      }),
    );
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm test tests/policy/invariants.test.ts`
Expected: some FAIL. Property tests over a wide space normally find at least one
boundary the table-driven tests missed — a zero committed rate, a zero balance, a floor
equal to the committed rate.

- [ ] **Step 3: Fix `decide` for whatever the properties found**

Do not weaken a property to make it pass. Each counterexample fast-check prints is a
real input the keeper can meet on chain; fix `decide` and keep the property as written.
Add each counterexample as a named case in the Task 2 or Task 3 table so it stays
covered by a fast, readable test.

- [ ] **Step 4: Re-run until green**

Run: `pnpm test tests/policy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/policy/invariants.test.ts src/policy/decide.ts
git commit -m "test(policy): the six invariants as property tests"
```

---

### Task 5: The reader

**Files:**
- Create: `src/chain/abi.ts`
- Create: `src/chain/reader.ts`
- Test: `tests/chain/reader.test.ts`
- Create: `tests/fixtures/sepolia-reads.json`

**Interfaces:**
- Consumes: `Facts`, `Address`, `Policy` types.
- Produces: `readFacts(deps: ReaderDeps, policy: Policy, nowSec: number): Promise<Facts>` and `type ReaderDeps = { client: PublicClientLike }`, where `PublicClientLike = { readContract: (args: never) => Promise<unknown> }`.

- [ ] **Step 1: Write the ABI fragments**

`src/chain/abi.ts`. `realtimeBalanceOf` is not in KeeperHub's SuperToken ABI, so it is
declared here. `balanceOf` alone cannot answer the question: it does not return the
deposit, and the deposit is what a liquidator takes.

```ts
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
```

The forwarder address above was confirmed byte for byte against
`keeperhub/protocols/superfluid.ts:253-254` on 2026-09-06, where the surrounding comment
records that Superfluid pins it identically across every chain it supports. Use it as
written; no further check is needed for this task.

- [ ] **Step 2: Write the failing tests**

`tests/chain/reader.test.ts` uses a fake client — no network:

```ts
import { describe, expect, it } from "vitest";
import { readFacts, ReadIncompleteError } from "../../src/chain/reader.js";
import type { Address, Policy } from "../../src/policy/types.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;

function policy(): Policy {
  return {
    version: 1, chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n, targetRunwaySec: 200n, hysteresisSec: 50n,
    recipients: [
      { address: A, label: "a", tier: "critical", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
      { address: B, label: "b", tier: "standard", committedRateWeiPerSec: 100n, floorRateWeiPerSec: 0n },
    ],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

function client(responses: Record<string, unknown>) {
  return {
    readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      const key = args.functionName === "realtimeBalanceOf"
        ? "balance"
        : `flow:${String(args.args[2]).toLowerCase()}`;
      const value = responses[key];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected read: ${key}`);
      return value;
    },
  };
}

describe("readFacts", () => {
  it("returns available balance, deposit and one stream per policy recipient", async () => {
    const facts = await readFacts(
      { client: client({
          balance: [5000n, 400n, 0n],
          [`flow:${A}`]: [1_699_000_000n, 60n, 200n, 0n],
          [`flow:${B}`]: [1_699_000_000n, 40n, 200n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.availableBalanceWei).toBe(5000n);
    expect(facts.depositWei).toBe(400n);
    expect(facts.streams).toEqual([
      { receiver: A, flowRateWeiPerSec: 60n },
      { receiver: B, flowRateWeiPerSec: 40n },
    ]);
  });

  it("clamps a negative available balance to zero", async () => {
    const facts = await readFacts(
      { client: client({
          balance: [-1n, 400n, 0n],
          [`flow:${A}`]: [0n, 0n, 0n, 0n],
          [`flow:${B}`]: [0n, 0n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    );
    expect(facts.availableBalanceWei).toBe(0n);
  });

  it("fails closed when any single read fails", async () => {
    await expect(
      readFacts(
        { client: client({
            balance: [5000n, 400n, 0n],
            [`flow:${A}`]: [0n, 60n, 0n, 0n],
            [`flow:${B}`]: new Error("RPC timeout"),
          }) },
        policy(),
        1_700_000_000,
      ),
    ).rejects.toBeInstanceOf(ReadIncompleteError);
  });

  it("names every failed read in the error", async () => {
    const error = await readFacts(
      { client: client({
          balance: new Error("RPC timeout"),
          [`flow:${A}`]: new Error("RPC timeout"),
          [`flow:${B}`]: [0n, 0n, 0n, 0n],
        }) },
      policy(),
      1_700_000_000,
    ).catch((e: unknown) => e as ReadIncompleteError);
    expect(error.failures).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run and watch fail**

Run: `pnpm test tests/chain/reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `readFacts`**

```ts
import { CFA_FORWARDER_ADDRESS, CFA_FORWARDER_READ_ABI, SUPER_TOKEN_READ_ABI } from "./abi.js";
import type { Facts, Policy, Stream } from "../policy/types.js";

export type ReadFailure = { what: string; reason: string };

export class ReadIncompleteError extends Error {
  readonly failures: readonly ReadFailure[];
  constructor(failures: ReadFailure[]) {
    super(
      [
        `${failures.length} chain read(s) failed; no decision was taken.`,
        ...failures.map((f) => `  - ${f.what}: ${f.reason}`),
      ].join("\n"),
    );
    this.name = "ReadIncompleteError";
    this.failures = failures;
  }
}

export type PublicClientLike = {
  readContract: (args: {
    address: string;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
};

export type ReaderDeps = { client: PublicClientLike };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readFacts(
  deps: ReaderDeps,
  policy: Policy,
  nowSec: number,
): Promise<Facts> {
  const failures: ReadFailure[] = [];

  const balanceResult = await deps.client
    .readContract({
      address: policy.token,
      abi: SUPER_TOKEN_READ_ABI,
      functionName: "realtimeBalanceOf",
      args: [policy.sender, BigInt(nowSec)],
    })
    .catch((error: unknown) => {
      failures.push({ what: "realtimeBalanceOf", reason: reason(error) });
      return null;
    });

  const streams: Stream[] = [];
  for (const recipient of policy.recipients) {
    const flow = await deps.client
      .readContract({
        address: CFA_FORWARDER_ADDRESS,
        abi: CFA_FORWARDER_READ_ABI,
        functionName: "getFlowInfo",
        args: [policy.token, policy.sender, recipient.address],
      })
      .catch((error: unknown) => {
        failures.push({ what: `getFlowInfo(${recipient.address})`, reason: reason(error) });
        return null;
      });
    if (flow !== null) {
      const [, flowRate] = flow as readonly [bigint, bigint, bigint, bigint];
      streams.push({ receiver: recipient.address, flowRateWeiPerSec: flowRate });
    }
  }

  if (failures.length > 0) throw new ReadIncompleteError(failures);

  const [available, deposit] = balanceResult as readonly [bigint, bigint, bigint];
  return {
    nowSec,
    // A negative available balance means the account is already insolvent.
    // Clamped to zero so runway arithmetic stays in the non-negative domain
    // rather than producing a negative runway that reads as "plenty of time".
    availableBalanceWei: available < 0n ? 0n : available,
    depositWei: deposit,
    streams,
  };
}
```

Reads are sequential rather than parallel: eight recipients is the realistic upper bound
here, and a serial loop keeps well inside any public RPC's rate limit without a batching
layer that would have to be tested too.

- [ ] **Step 5: Run and watch pass**

Run: `pnpm test tests/chain/reader.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/chain tests/chain
git commit -m "feat(chain): fail-closed reader for balance, deposit and per-stream rates"
```

---

### Task 5b: Account for outflow the policy does not list

**Files:**
- Modify: `src/policy/types.ts` (add one field to `Facts`)
- Modify: `src/policy/decide.ts` (one line in the runway calculation)
- Modify: `src/chain/reader.ts`, `src/chain/abi.ts`
- Modify: `tests/policy/decide-reduce.test.ts`, `tests/policy/decide-restore.test.ts`, `tests/policy/invariants.test.ts`, `tests/chain/reader.test.ts` (helper defaults only)
- Test: `tests/policy/decide-unlisted.test.ts`, and new cases in `tests/chain/reader.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 through 5.
- Produces: `Facts.unlistedOutflowWeiPerSec: bigint`.

**Why this task exists.** `readFacts` builds its stream list by walking `policy.recipients`,
so a stream to an address the policy does not list is invisible to it. That money still
leaves the account every second. The runway would be computed as if it were not, and the
keeper would believe it has more time than it has — the one direction in which this
number must never err.

The fix is a single extra read. The CFAv1Forwarder exposes
`getAccountFlowrate(token, account)`, which returns the account's **whole** net flow rate,
listed streams and unlisted alike. The difference between that and the sum of the listed
streams is exactly the outflow the policy does not know about. KeeperHub exposes the same
read as `get-cfa-net-flow`, so this is a protocol-native check rather than an invention.

Runway still only ever adjusts streams the policy names — it has no mandate over the
others and must not pretend to. But it counts their drain when it decides how long the
money lasts, and when the unlisted drain alone exceeds the budget, the existing
`floors-exceed-budget` escalation fires on its own.

- [ ] **Step 1: Add the field, defaulting every existing fixture to zero**

Add to `Facts` in `src/policy/types.ts`:

```ts
  /**
   * Net outflow, in wei per second, to receivers the policy does not list.
   * Runway cannot adjust these streams -- it has no mandate over them -- but
   * their drain is real and counts against how long the money lasts.
   */
  unlistedOutflowWeiPerSec: bigint;
```

Then set `unlistedOutflowWeiPerSec: 0n` in the `facts()` helper of every existing test
file and in the Task 4 generator. Zero reproduces today's behaviour exactly, so every
expectation written in Tasks 2, 3 and 4 must still pass untouched. If any of them changes,
stop and report it — that would mean this field is doing something it should not.

- [ ] **Step 2: Run the existing suite and confirm it is still green**

Run: `pnpm test`
Expected: PASS, with the same counts as before this task. This is the regression gate for
the whole change; run it before writing a line of new logic.

- [ ] **Step 3: Write the failing tests for the new behaviour**

`tests/policy/decide-unlisted.test.ts`:

```ts
describe("decide — unlisted outflow", () => {
  it("counts unlisted outflow against the runway", () => {
    // Listed 200/sec plus 100/sec unlisted is 300/sec against 15000: a 50s
    // runway, not the 75s the listed streams alone would suggest.
    const f = { ...facts(15_000n, [100n, 100n, 0n]), unlistedOutflowWeiPerSec: 100n };
    expect(decide(f, policy()).runwaySec).toBe(50n);
  });

  it("breaches on unlisted outflow alone", () => {
    // Nothing listed is flowing, but 300/sec is leaving anyway.
    const f = { ...facts(15_000n, [0n, 0n, 0n]), unlistedOutflowWeiPerSec: 300n };
    const d = decide(f, policy());
    expect(d.kind).toBe("reduce");
    expect(d.breach).toBe(true);
  });

  it("never emits an adjustment for an unlisted receiver", () => {
    const f = { ...facts(15_000n, [100n, 100n, 0n]), unlistedOutflowWeiPerSec: 100n };
    const known = new Set(policy().recipients.map((r) => r.address));
    for (const a of decide(f, policy()).adjustments) {
      expect(known.has(a.receiver)).toBe(true);
    }
  });

  it("escalates when the unlisted drain alone exceeds the budget", () => {
    // budget = 15000/200 = 75/sec, all of which the unlisted 300/sec consumes.
    // Every listed stream can go to its floor and it still will not be enough.
    const f = { ...facts(15_000n, [100n, 100n, 100n]), unlistedOutflowWeiPerSec: 300n };
    expect(decide(f, policy()).escalation?.kind).toBe("floors-exceed-budget");
  });

  it("still reports a null runway when nothing at all is flowing", () => {
    const f = { ...facts(15_000n, [0n, 0n, 0n]), unlistedOutflowWeiPerSec: 0n };
    expect(decide(f, policy()).runwaySec).toBeNull();
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm test tests/policy/decide-unlisted.test.ts`
Expected: FAIL — the runway ignores the new field, so the first case reports 75n.

- [ ] **Step 5: Change the one line in `decide`**

`netOutflow` becomes the total drain rather than the shed-able drain:

```ts
const listedOutflow = ordered.reduce((sum, e) => sum + e.rate, 0n);
const netOutflow = listedOutflow + facts.unlistedOutflowWeiPerSec;
```

`netOutflow` continues to drive `runwaySec` and `need`. The shed loop keeps walking
`ordered`, which holds only listed streams, so Runway still adjusts nothing it lacks a
mandate for. The zero-outflow early return now tests the total, so an account with only
unlisted streams is correctly seen as draining.

- [ ] **Step 6: Add the reader's second read**

Add `getAccountFlowrate` to `CFA_FORWARDER_READ_ABI` in `src/chain/abi.ts`:

```ts
  {
    type: "function",
    name: "getAccountFlowrate",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "int96" }],
  },
```

This fragment was called against the live CFAv1Forwarder on Sepolia at block 11646961 and
returned a single `int96` without reverting.

In `readFacts`, read the account flow rate alongside the per-stream reads, under the same
fail-closed rule — a failure here joins `failures` and no decision is taken. Then:

```ts
// getAccountFlowrate is negative for a net sender. Listed streams are the
// ones the policy named; whatever drains beyond them is unlisted.
const totalOutflow = accountFlowrate < 0n ? -accountFlowrate : 0n;
const listedOutflow = streams.reduce((sum, s) => sum + s.flowRateWeiPerSec, 0n);
const unlistedOutflowWeiPerSec =
  totalOutflow > listedOutflow ? totalOutflow - listedOutflow : 0n;
```

The clamp matters: an account that receives more than it sends has a positive net rate,
and a treasury whose listed streams exceed the measured total (possible for one block
around an update) must not produce a negative field.

- [ ] **Step 7: Add the reader tests**

Cover: a net receiver (positive rate) yields `0n`; an account draining more than its listed
streams yields the difference; listed exceeding total yields `0n` rather than a negative;
and a failing `getAccountFlowrate` read fails the whole call closed, exactly as a failing
`getFlowInfo` does.

- [ ] **Step 8: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm check`
Expected: PASS, all previous tests unchanged plus the new ones.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "feat(policy): count outflow the policy does not list against the runway"
```

---

### Task 6: The KeeperHub executor

**Files:**
- Create: `src/keeperhub/client.ts`
- Create: `src/keeperhub/idempotency.ts`
- Create: `src/keeperhub/execute.ts`
- Test: `tests/keeperhub/idempotency.test.ts`
- Test: `tests/keeperhub/execute.test.ts`

**Interfaces:**
- Consumes: `Adjustment`, `Policy`.
- Produces:
  - `idempotencyKey(policy: Policy, adjustment: Adjustment, nowSec: number): string`
  - `executeAdjustment(deps: ExecutorDeps, policy: Policy, adjustment: Adjustment, nowSec: number): Promise<ExecutionOutcome>`
  - `type ExecutorDeps = { fetch: typeof globalThis.fetch; baseUrl: string; apiKey: string; simulate: (adjustment: Adjustment, policy: Policy) => Promise<void>; sleep: (ms: number) => Promise<void> }`
  - `type ExecutionOutcome = { status: "landed"; transactionHash: string; transactionLink: string; gasUsedWei: string; sponsored: boolean } | { status: "refused"; stage: "simulate" | "broadcast"; detail: string } | { status: "unresolved"; detail: string }`

No outcome carries an `executionId`, because the protocol-write response body has none.
`simulate` is injected rather than called directly so the tests can drive the gate without
an RPC; it rejects when the call would revert, and a rejection means no POST is sent.

`sleep` is injected so the polling tests run instantly instead of waiting on a real
timer; production passes a real one.

- [ ] **Step 1: Write the idempotency-key tests**

The key must identify the work, not the attempt, and must carry a time bucket because
KeeperHub replays a stored response for only 24 hours — past that the same key executes
again, silently.

```ts
import { describe, expect, it } from "vitest";
import { idempotencyKey } from "../../src/keeperhub/idempotency.js";

describe("idempotencyKey", () => {
  it("is stable for the same work inside one bucket", () => {
    expect(idempotencyKey(policy(), adjustment(), 1_700_000_000)).toBe(
      idempotencyKey(policy(), adjustment(), 1_700_000_100),
    );
  });

  it("differs once the bucket rolls over", () => {
    const HOUR = 3600;
    expect(idempotencyKey(policy(), adjustment(), 1_700_000_000)).not.toBe(
      idempotencyKey(policy(), adjustment(), 1_700_000_000 + 6 * HOUR),
    );
  });

  it("differs for a different target rate", () => {
    const other = { ...adjustment(), toRateWeiPerSec: 42n };
    expect(idempotencyKey(policy(), adjustment(), 1_700_000_000)).not.toBe(
      idempotencyKey(policy(), other, 1_700_000_000),
    );
  });

  it("differs for a different receiver", () => {
    const other = { ...adjustment(), receiver: "0x9999999999999999999999999999999999999999" as const };
    expect(idempotencyKey(policy(), adjustment(), 1_700_000_000)).not.toBe(
      idempotencyKey(policy(), other, 1_700_000_000),
    );
  });
});
```

Add local `policy()` and `adjustment()` helpers in this file.

- [ ] **Step 2: Implement the key**

```ts
import { createHash } from "node:crypto";
import type { Adjustment, Policy } from "../policy/types.js";

/**
 * KeeperHub replays a stored response for 24 hours and then silently executes
 * the same key again. A 6-hour bucket keeps a retry inside one window while
 * guaranteeing the key has rotated well before the replay window expires.
 */
const BUCKET_SEC = 6 * 3600;

export function idempotencyKey(
  policy: Policy,
  adjustment: Adjustment,
  nowSec: number,
): string {
  const bucket = Math.floor(nowSec / BUCKET_SEC);
  const material = [
    "runway.v1",
    String(policy.chainId),
    policy.token,
    policy.sender,
    adjustment.receiver,
    adjustment.toRateWeiPerSec.toString(),
    String(bucket),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
```

- [ ] **Step 3: Run the key tests**

Run: `pnpm test tests/keeperhub/idempotency.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 4: Write the failing executor tests**

Use a stub `fetch` injected through `ExecutorDeps`, never a real network call. Build a
fresh stub per test — a shared mutable stub makes a failure in one test look like a bug
in another.

> **Superseded, kept for the record.** The test code in this step was written against
> KeeperHub's published `/transfer` flow: a `202` carrying an `executionId`, then polling
> `/api/execute/{id}/status` for a verified receipt, with `"simulate": true` sent to the
> API. None of that applies to the protocol-action route, as the Global Constraints above
> now record. The shipped tests in `tests/keeperhub/execute.test.ts` follow the corrected
> contract: local simulation through `deps.simulate`, no `simulate` field in any request
> body, and a terminal response with no polling. Read them rather than the block below,
> which is left here only so the correction is legible.

```ts
import { describe, expect, it } from "vitest";
import { executeAdjustment } from "../../src/keeperhub/execute.js";
import type { ExecutorDeps } from "../../src/keeperhub/execute.js";

type Call = { kind: "simulate" | "broadcast" | "status"; body: unknown; key: string | null };

/**
 * `scripted` is consumed in order for the POST calls, then `statuses` in order
 * for each poll. Each entry is [httpStatus, jsonBody].
 */
function stub(
  calls: Call[],
  scripted: [number, unknown][],
  statuses: [number, unknown][] = [],
): ExecutorDeps {
  let postIndex = 0;
  let statusIndex = 0;
  return {
    baseUrl: "https://keeperhub.test",
    apiKey: "kh_test",
    pollBudgetMs: 5_000,
    sleep: async () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const isStatus = String(url).endsWith("/status");
      if (isStatus) {
        const entry = statuses[statusIndex++] ?? statuses.at(-1);
        if (!entry) throw new Error("no scripted status response");
        calls.push({ kind: "status", body: null, key: null });
        return new Response(JSON.stringify(entry[1]), { status: entry[0] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ kind: body.simulate === true ? "simulate" : "broadcast", body, key });
      const entry = scripted[postIndex++];
      if (!entry) throw new Error("no scripted POST response");
      return new Response(JSON.stringify(entry[1]), { status: entry[0] });
    }) as typeof globalThis.fetch,
  };
}

const OK_SIM = [200, { success: true, wouldRevert: false }] as [number, unknown];
const ACCEPTED = [202, { success: true, executionId: "direct_1" }] as [number, unknown];
const LANDED = [
  200,
  {
    executionId: "direct_1",
    status: "completed",
    transactionHash: "0xabc",
    transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
    gasUsedWei: "21000000000000",
    receipts: [{ hash: "0xabc", verified: true, receiptStatus: "success" }],
  },
] as [number, unknown];

describe("executeAdjustment", () => {
  it("simulates first and refuses to broadcast when the simulation would revert", async () => {
    const calls: Call[] = [];
    const outcome = await executeAdjustment(
      stub(calls, [[200, { success: true, wouldRevert: true, error: "CFA: ACL denied" }]]),
      policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome.status).toBe("refused");
    expect(calls.filter((c) => c.kind === "broadcast")).toHaveLength(0);
  });

  it("sends the identical body to broadcast that it sent to simulate", async () => {
    const calls: Call[] = [];
    await executeAdjustment(stub(calls, [OK_SIM, ACCEPTED], [LANDED]), policy(), adjustment(), 1_700_000_000);
    const sim = calls.find((c) => c.kind === "simulate")?.body as Record<string, unknown>;
    const broadcast = calls.find((c) => c.kind === "broadcast")?.body;
    const { simulate: _dropped, ...simWithoutFlag } = sim;
    expect(broadcast).toEqual(simWithoutFlag);
  });

  it("carries an Idempotency-Key on the broadcast and none on the simulation", async () => {
    const calls: Call[] = [];
    await executeAdjustment(stub(calls, [OK_SIM, ACCEPTED], [LANDED]), policy(), adjustment(), 1_700_000_000);
    expect(calls.find((c) => c.kind === "simulate")?.key).toBeNull();
    expect(calls.find((c) => c.kind === "broadcast")?.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reports landed only when a receipt is verified and successful", async () => {
    const outcome = await executeAdjustment(
      stub([], [OK_SIM, ACCEPTED], [LANDED]), policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome).toMatchObject({ status: "landed", transactionHash: "0xabc" });
  });

  it("refuses a completed execution whose receipt reverted", async () => {
    const reverted = [
      200,
      {
        executionId: "direct_1",
        status: "completed",
        transactionHash: "0xdead",
        receipts: [{ hash: "0xdead", verified: true, receiptStatus: "reverted" }],
      },
    ] as [number, unknown];
    const outcome = await executeAdjustment(
      stub([], [OK_SIM, ACCEPTED], [reverted]), policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome.status).toBe("refused");
  });

  it("refuses a completed execution that carries no verified receipt at all", async () => {
    const noReceipt = [
      200,
      { executionId: "direct_1", status: "completed", transactionHash: "0xabc", receipts: [] },
    ] as [number, unknown];
    const outcome = await executeAdjustment(
      stub([], [OK_SIM, ACCEPTED], [noReceipt]), policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome.status).toBe("refused");
  });

  it("reports unresolved when polling exhausts its budget without a terminal status", async () => {
    const pending = [200, { executionId: "direct_1", status: "running", receipts: [] }] as [number, unknown];
    const outcome = await executeAdjustment(
      stub([], [OK_SIM, ACCEPTED], [pending]), policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome).toMatchObject({ status: "unresolved", executionId: "direct_1" });
  });

  it("retries idempotency_in_progress with the same key", async () => {
    const calls: Call[] = [];
    const inProgress = [409, { code: "idempotency_in_progress", retryable: true }] as [number, unknown];
    await executeAdjustment(
      stub(calls, [OK_SIM, inProgress, ACCEPTED], [LANDED]), policy(), adjustment(), 1_700_000_000,
    );
    const keys = calls.filter((c) => c.kind === "broadcast").map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("refuses on idempotency_conflict and never rotates the key itself", async () => {
    const calls: Call[] = [];
    const conflict = [
      409,
      { code: "idempotency_conflict", retryable: false, originalExecutionId: "direct_0" },
    ] as [number, unknown];
    const outcome = await executeAdjustment(
      stub(calls, [OK_SIM, conflict]), policy(), adjustment(), 1_700_000_000,
    );
    expect(outcome.status).toBe("refused");
    expect(calls.filter((c) => c.kind === "broadcast")).toHaveLength(1);
  });

  it("never puts the API key in an outcome", async () => {
    const outcome = await executeAdjustment(
      stub([], [[200, { success: false, error: "boom" }]]), policy(), adjustment(), 1_700_000_000,
    );
    expect(JSON.stringify(outcome)).not.toContain("kh_test");
  });
});
```

Add local `policy()` and `adjustment()` helpers in this file, matching the ones in
Task 2's suite.

- [ ] **Step 5: Implement the executor**

`src/keeperhub/execute.ts`:

1. Build the body once:
   `{ chainId, token, sender, receiver, flowRate: toRateWeiPerSec.toString(), userData: "0x" }`.
2. **Simulate locally**, through `deps.simulate` — a viem `simulateContract` call against
   `CFA_FORWARDER_ADDRESS.updateFlow` with the same arguments and `account` set to the
   KeeperHub Turnkey EOA. Continue only if it does not revert. This is what catches an
   ACL denial, a missing mandate, or an exhausted allowance, and it catches them before
   spending one of the organisation's metered executions.
3. `POST /api/execute/superfluid/update-flow` with that body, header
   `Idempotency-Key: <idempotencyKey(...)>` and `Authorization: Bearer <key>`.
4. **The response is terminal.** `success: true` with a `transactionHash` is `landed`:
   KeeperHub has already re-fetched and verified the receipt against the chain before
   answering. `success: false` is `refused`, carrying `error` and, when present,
   `rejection`. The body also carries `transactionLink`, `gasUsed`, `effectiveGasPrice`
   and `sponsored`; record them.
5. `unresolved` is reserved for the case where our own request failed in a way that
   leaves the outcome unknown — a socket error or a timeout after the request was sent.
   The idempotency key is what makes the next tick safe: the route finalises a broadcast
   key as success or failed and never releases it, so a retry cannot re-broadcast.

A `409` with `code: "idempotency_in_progress"` is retried with the same key. A `409` with
`code: "idempotency_conflict"` is `refused`: the body differs from what that key first
sent, and rotating the key here would broadcast a second transaction for work that may
already be live.

`sponsored: true` means a relayer submitted the transaction, so the explorer will show a
sender that is not our wallet and a value of `0`. Record the flag beside the hash, or the
evidence document will look wrong to anyone who checks it.

The API key is read from `process.env.KEEPERHUB_API_KEY` at the call site and passed in
through `ExecutorDeps`. It is never logged, never included in an error message, and never
written to a run record.

- [ ] **Step 6: Run the executor tests**

Run: `pnpm test tests/keeperhub`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/keeperhub tests/keeperhub
git commit -m "feat(keeperhub): simulate-then-broadcast executor with receipt verification"
```

---

### Task 7: The runner and the run record

**Files:**
- Create: `src/runner/run.ts`
- Create: `src/runner/record.ts`
- Create: `src/runner/escalate.ts`
- Create: `src/cli.ts`
- Test: `tests/runner/run.test.ts`

**Interfaces:**
- Consumes: `readFacts`, `decide`, `executeAdjustment`, `loadPolicy`.
- Produces:
  - `runOnce(deps: RunDeps, policy: Policy, nowSec: number): Promise<RunRecord>`
  - `type RunDeps = { readFacts: (policy: Policy, nowSec: number) => Promise<Facts>; execute: (policy: Policy, adjustment: Adjustment, nowSec: number) => Promise<ExecutionOutcome>; notify: (webhook: string, payload: unknown) => Promise<void> }`
  - `type RunRecord = { startedAt: string; nowSec: number; facts: Facts | null; decision: Decision | null; outcomes: { adjustment: Adjustment; outcome: ExecutionOutcome }[]; escalations: { kind: string; detail: string; delivered: boolean }[] }`, written to `runs/<iso-timestamp>.json`.

  - `toSerialisable(record: RunRecord): unknown` from `src/runner/record.ts` — the single
    place a `bigint` becomes a decimal string, so no other module has to remember.

Every collaborator arrives as a function on `RunDeps`, so the runner's tests never touch
a network and never construct a client.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { runOnce } from "../../src/runner/run.js";
import { ReadIncompleteError } from "../../src/chain/reader.js";

const LANDED = { status: "landed", transactionHash: "0xabc",
  transactionLink: "https://sepolia.etherscan.io/tx/0xabc", gasUsedWei: "1" } as const;
const REFUSED = { status: "refused", stage: "broadcast", detail: "CFA: ACL denied" } as const;

/** `facts()`, `policy()` and `adjustment()` are local helpers, as in Task 2. */
function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    readFacts: async () => facts(15_000n, [100n, 100n, 100n]),
    execute: async () => LANDED,
    notify: async () => {},
    ...over,
  };
}

describe("runOnce", () => {
  it("records the facts, the decision and one outcome per adjustment", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(record.decision?.kind).toBe("reduce");
    expect(record.outcomes).toHaveLength(record.decision?.adjustments.length ?? -1);
  });

  it("executes nothing on a hold decision", async () => {
    let executed = 0;
    const record = await runOnce(
      deps({
        readFacts: async () => facts(30_000n, [100n, 100n, 100n]),
        execute: async () => { executed += 1; return LANDED; },
      }),
      policy(), 1_700_000_000,
    );
    expect(record.decision?.kind).toBe("hold");
    expect(executed).toBe(0);
  });

  it("takes no decision and executes nothing when the read fails", async () => {
    let executed = 0;
    const record = await runOnce(
      deps({
        readFacts: async () => { throw new ReadIncompleteError([{ what: "getFlowInfo", reason: "timeout" }]); },
        execute: async () => { executed += 1; return LANDED; },
      }),
      policy(), 1_700_000_000,
    );
    expect(record.decision).toBeNull();
    expect(executed).toBe(0);
    expect(record.escalations.map((e) => e.kind)).toContain("read-incomplete");
  });

  it("still executes the cuts when the decision carries an escalation", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).toContain("floors-exceed-budget");
    expect(record.outcomes.length).toBeGreaterThan(0);
  });

  it("continues to the remaining adjustments after one is refused", async () => {
    let call = 0;
    const record = await runOnce(
      deps({ execute: async () => (call++ === 0 ? REFUSED : LANDED) }),
      policy(), 1_700_000_000,
    );
    expect(record.outcomes).toHaveLength(record.decision?.adjustments.length ?? -1);
    expect(record.outcomes.some((o) => o.outcome.status === "landed")).toBe(true);
  });

  it("raises a run-level escalation when a write is refused", async () => {
    const record = await runOnce(deps({ execute: async () => REFUSED }), policy(), 1_700_000_000);
    expect(record.escalations.map((e) => e.kind)).toContain("mandate-rejected");
  });

  it("records a failed escalation rather than swallowing it", async () => {
    const record = await runOnce(
      deps({ notify: async () => { throw new Error("webhook 500"); } }),
      policy(), 1_700_000_000,
    );
    expect(record.escalations.every((e) => e.delivered === false)).toBe(true);
  });

  it("serialises every bigint as a decimal string", async () => {
    const record = await runOnce(deps(), policy(), 1_700_000_000);
    expect(() => JSON.stringify(toSerialisable(record))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test tests/runner/run.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runOnce`**

The shape, in order: read facts (a `ReadIncompleteError` ends the run with
`escalation: "read-incomplete"` and zero executions); decide; if `kind === "hold"`,
record and stop without a single network write; otherwise execute each adjustment in the
order the decision listed them, collecting outcomes and continuing past a refusal;
finally, post any escalation to `policy.escalation.webhook` and record whether that post
itself succeeded.

`RunRecord` carries: `startedAt`, `nowSec`, `facts` (bigints as decimal strings),
`decision`, `outcomes[]` with transaction hash and link for each landed write, gas paid,
and `escalations[]`. Serialisation goes through one helper that converts every `bigint`
to a string, so a `bigint` never reaches `JSON.stringify` unhandled.

- [ ] **Step 4: Implement the CLI**

`src/cli.ts` takes a policy path and a `--dry-run` flag. With `--dry-run` it reads and
decides but constructs no executor, so it cannot write. It prints the decision as a
table. Without it, it runs `runOnce` and prints the run record path.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS, every task so far.

- [ ] **Step 6: Commit**

```bash
git add src/runner src/cli.ts tests/runner
git commit -m "feat(runner): one tick from facts to verified writes, with a run record"
```

---

### Task 8: The read-only page

**Files:**
- Create: `src/report/render.ts`
- Create: `src/report/template.ts`
- Test: `tests/report/render.test.ts`

**Interfaces:**
- Consumes: `RunRecord`.
- Produces: `renderReport(records: RunRecord[]): string` — a single self-contained HTML document.

- [ ] **Step 1: Write the failing tests**

The tests assert the properties that matter, not the markup:

```ts
import { describe, expect, it } from "vitest";
import { renderReport } from "../../src/report/render.js";

/** A minimal landed run; each test overrides only what it asserts on. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: "2026-09-10T12:00:00.000Z",
    nowSec: 1_757_505_600,
    facts: facts(15_000n, [100n, 100n, 100n]),
    decision: decide(facts(15_000n, [100n, 100n, 100n]), policy()),
    outcomes: [
      {
        adjustment: adjustment(),
        outcome: {
          status: "landed", transactionHash: "0xabc",
          transactionLink: "https://sepolia.etherscan.io/tx/0xabc", gasUsedWei: "1",
        },
      },
    ],
    escalations: [],
    ...over,
  };
}

describe("renderReport", () => {
  it("shows the runway of the most recent run in hours", () => {
    // 15000 wei available at 300 wei/sec is 50 seconds of runway.
    expect(renderReport([record()])).toContain("50");
  });

  it("links every landed transaction to the explorer link the record carries", () => {
    expect(renderReport([record()])).toContain("https://sepolia.etherscan.io/tx/0xabc");
  });

  it("is self-contained: no script, no external stylesheet, no remote image", () => {
    const html = renderReport([record()]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain('src="http');
  });

  it("escapes a value that came off the chain", () => {
    const hostile = record({
      outcomes: [
        {
          adjustment: adjustment(),
          outcome: {
            status: "refused", stage: "broadcast",
            detail: '<img src=x onerror="alert(1)">',
          },
        },
      ],
    });
    const html = renderReport([hostile]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("states plainly when a run took no action", () => {
    const quiet = record({
      decision: decide(facts(30_000n, [100n, 100n, 100n]), policy()),
      outcomes: [],
    });
    expect(renderReport([quiet])).toMatch(/no action/i);
  });

  it("renders an empty history without throwing", () => {
    expect(() => renderReport([])).not.toThrow();
  });
});
```

An escaping test on a report that only ever shows our own data may look like ceremony.
It is not: `outcome.detail` carries a revert string that originates in a contract, and a
contract's revert string is attacker-controlled input.

The self-containment test is the one that matters for the submission: the page has to
render for a judge who opens the file with no network.

- [ ] **Step 2: Run and watch fail, implement, run again**

Run: `pnpm test tests/report/render.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/report tests/report
git commit -m "feat(report): self-contained run report"
```

---

### Task 9: Sepolia setup and the mandate

**Files:**
- Create: `scripts/check-config.ts`
- Create: `scripts/resolve-sepolia.ts`
- Create: `docs/SETUP.md`

**Interfaces:**
- Consumes: nothing from earlier tasks except the ABI fragments.
- Produces: a filled `policies/treasury.sepolia.yaml` and a granted mandate on chain.

> **Human-only steps.** Creating the KeeperHub account, generating the `kh_` API key,
> provisioning the Turnkey wallet, and signing the `grant-flow-operator` transaction are
> done by the human partner in their own browser and wallet. No script asks for a
> password, a seed phrase or a private key, and no secret value is pasted into the
> conversation or into a committed file.

- [ ] **Step 1: Write the configuration checker**

`scripts/check-config.ts` prints presence booleans only — never a value, never a prefix:

```ts
const NAMES = ["KEEPERHUB_API_KEY", "KEEPERHUB_BASE_URL", "SEPOLIA_RPC_URL"] as const;
for (const name of NAMES) {
  console.log(`${name}: ${process.env[name] ? "present" : "MISSING"}`);
}
```

- [ ] **Step 2: Confirm Sepolia is enabled for the organisation**

Run: `curl -sS -H "Authorization: Bearer $KEEPERHUB_API_KEY" "$KEEPERHUB_BASE_URL/api/chains"`
Expected: an entry for `11155111` with `isEnabled: true` and `isTestnet: true`.
If it is absent, stop and enable it in the KeeperHub UI before continuing.

- [ ] **Step 3: Resolve the Sepolia addresses from the chain**

**The token is ETHx**, Superfluid's native-asset super token for Sepolia, at
`0x30a6933Ca9230361972E413a15dC8114c952414e`. This was read from Superfluid's own network
registry (`superfluid-finance/protocol-monorepo`, `packages/metadata/networks.json`, the
`eth-sepolia` entry) on 2026-09-06, together with `cfaV1Forwarder`
`0xcfA132E353cB4E398080B9700609bb008eceB125` — which matches KeeperHub's constant exactly.

Do not look for fDAIx. No testnet entry in that registry carries a `testTokens` array, so
there is no Superfluid test-token faucet to draw on. ETHx is better anyway: its underlying
is Sepolia ETH, which many public faucets hand out, so the funding path has no single
point of failure.

`scripts/resolve-sepolia.ts` verifies rather than assumes. It reads and prints: the ETHx
address responds to `getUnderlyingToken()`, the CFA minimum deposit governance has set for
it, and the CFAv1Forwarder's `getFlowInfo` for a zero-flow pair (proving the contract is
live and the ABI matches). A zero address, a revert, or a failed call stops the script.

Write the resolved values into `policies/treasury.sepolia.yaml`, and record in
`docs/SETUP.md` the date they were read and the block number.

- [ ] **Step 4: Fund the treasury and open three streams**

Human steps, documented in `docs/SETUP.md`: obtain Sepolia ETH from a public faucet, wrap
it into ETHx, then open three streams — one per tier — sized so that the treasury's runway
starts comfortably above `targetRunwayHours + hysteresisHours`.

**Wrapping ETHx does not go through KeeperHub.** ETHx is a native-asset super token: it is
wrapped with the payable `upgradeByETH()`, not the `upgrade(uint256)` that KeeperHub's
`wrap` action calls, because there is no underlying ERC-20 to pull. Wrap from the treasury
wallet directly — through the Superfluid dashboard or a direct call. This costs the
project nothing: wrapping is setup, and only the keeper's `update-flow` writes need to run
through KeeperHub.

**Sizing, from numbers measured on Sepolia at block 11646961, not from mainnet lore.**
Superfluid's governance on Sepolia (`0x9539B21cC67844417E80aE168bc28c831E7Ed271`) reports
`superTokenMinimumDeposit = 0` for ETHx — there is no governance floor here, unlike the
69 DAI that mainnet DAIx locks. What binds instead is the liquidation period, read from
the same governance as `PPPConfiguration`: **3600 seconds**, with a patrician period of
720 seconds.

So each stream locks `flowRate x 3600` as its buffer. Three streams need
`3600 x (sum of the three committed rates)` wrapped purely as buffer, on top of whatever
they will actually pay out over the demo. Size the wrap from that, or `create-flow`
reverts with `CFA_INSUFFICIENT_BALANCE`.

Note this number in `docs/SETUP.md`, because it is also the project's headline: the
protocol's own safety margin is one hour, and Runway's default warning threshold is 72.

- [ ] **Step 5: Grant the mandate**

The treasury signs one `grant-flow-operator`: `flowOperator` is the KeeperHub Turnkey EOA
address, `permissions` is `6`, `flowRateAllowance` is the sum of the three committed
rates. Record the transaction hash in `docs/SETUP.md`.

Verify the mandate landed by reading it back on chain before continuing. A mandate that
was not actually granted produces a revert at the first write, several steps later, where
it is much harder to read.

- [ ] **Step 6: Dry run**

Run: `pnpm tsx src/cli.ts policies/treasury.sepolia.yaml --dry-run`
Expected: a `hold` decision, a runway well above the minimum, and no write attempted.

- [ ] **Step 7: Commit**

```bash
git add scripts docs/SETUP.md policies/treasury.sepolia.yaml
git commit -m "chore(sepolia): setup scripts, resolved addresses and the granted mandate"
```

---

### Task 10: The verified transaction and the scheduled workflow

**Files:**
- Modify: `docs/SETUP.md`
- Create: `docs/EVIDENCE.md`
- Test: `tests/docs/evidence.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: the transaction link the submission requires.

- [ ] **Step 1: Tighten the budget until the policy must act**

Unwrap part of the ETHx balance — `downgradeToETH` — so the runway falls below
`minRunwayHours`. This is the honest way to produce the breach: the treasury really does
have less money, rather than the threshold being moved to manufacture an alarm.

- [ ] **Step 2: Dry run and read the decision**

Run: `pnpm tsx src/cli.ts policies/treasury.sepolia.yaml --dry-run`
Expected: `kind: "reduce"`, the discretionary stream cut first, and a target rate at or
above its floor. Read the decision before allowing any write.

- [ ] **Step 3: Run for real**

Run: `pnpm tsx src/cli.ts policies/treasury.sepolia.yaml`
Expected: each adjustment simulated, then broadcast, then polled to
`verified: true` and `receiptStatus: "success"`. The run record holds the transaction
hash and link.

- [ ] **Step 4: Verify independently**

Read the new flow rate back from the chain with `getFlowInfo` and confirm it equals the
decision's `toRateWeiPerSec`. A mined receipt proves a transaction landed; only the read
proves the stream actually changed. KeeperHub's own test suite makes exactly this
distinction, and so should ours.

- [ ] **Step 5: Write the evidence document, with a test that reads it back**

`docs/EVIDENCE.md` records the transaction hash, the explorer link, the block number, the
rate before and after, and the gas paid. `tests/docs/evidence.test.ts` parses those
values out of the newest run record in `runs/` and asserts the document quotes them.

This is the stale-number defect class that has bitten this workspace before: no figure
goes into a document unless a test reads it back off its source.

- [ ] **Step 6: Create the scheduled KeeperHub workflow**

In the KeeperHub UI or through the MCP server, create a scheduled workflow that calls the
runner and routes the escalation through a KeeperHub notification action. Record the
workflow ID in `docs/EVIDENCE.md`.

- [ ] **Step 7: Full suite, lint, typecheck**

Run: `pnpm test && pnpm check && pnpm typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add docs/EVIDENCE.md tests/docs runs
git commit -m "docs: verified Sepolia execution evidence, asserted by test"
```

---

## Submission checklist

Not implementation work, but phase 1 is not delivered until these are done. Each is a
human step, and none is performed without the human partner's explicit go-ahead — pushing
a repository and publishing a submission are both outward-facing and irreversible.

- [ ] Public repository pushed, with `README.md` explaining the mandate model in the
      first screen.
- [ ] The verified transaction link from `docs/EVIDENCE.md` copied into the submission.
- [ ] DoraHacks BUIDL created for the **main track**, before Sep 18 12:00 CEST. Kept
      separate from the bounty BUIDL for KeeperHub issue #2325: a BUIDL applies to one
      track only.
- [ ] Demo video recorded: the runway falling, the decision printed by the dry run, the
      transaction landing, and the flow rate read back off the chain afterwards.

## What phase 1 does not include

Deferred to phase 2, deliberately, and not to be started until every task above is done
and demonstrated: the policy editor, the rich run history, and any hosted UI beyond the
static report from Task 8.
