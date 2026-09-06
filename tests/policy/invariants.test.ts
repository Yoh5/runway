import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/policy/decide.js";
import { type Address, type Facts, type Policy, TIER_ORDER } from "../../src/policy/types.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const rate = fc.bigInt({ min: 0n, max: 10n ** 12n });

const scenario = fc
  .record({
    count: fc.integer({ min: 1, max: 8 }),
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
      .chain((mid) => {
        const targetRunwaySec = BigInt(base.minHours + base.extraHours) * 3600n;
        const committedOutflow = mid.committed.reduce((sum, c) => sum + c, 0n);
        // A flat 0..10^24 balance almost never lands near the budget: rates
        // cap at 10^12 and runways at ~2.52M seconds, so any balance small
        // enough to trigger a reduce is nearly always small enough to put the
        // budget below the floor sum too, and escalation fires. Anchoring a
        // second source of balance to 0-3x the committed outflow at the
        // target runway puts a real fraction of draws in the band where
        // budget and outflow are comparable — where a shed can actually land
        // without exhausting every floor.
        const anchoredBalance = fc
          .integer({ min: 0, max: 300 })
          .map((pct) => (committedOutflow * targetRunwaySec * BigInt(pct)) / 100n);
        const wideBalance = fc.bigInt({ min: 0n, max: 10n ** 24n });
        // Weighted 3:1 toward the anchored band: the wide range still covers
        // the extremes, but most draws should land where budget and outflow
        // are actually comparable.
        return fc
          .oneof({ arbitrary: wideBalance, weight: 1 }, { arbitrary: anchoredBalance, weight: 3 })
          .map((balance) => ({ ...mid, balance }));
      })
      .map(({ committed, floorFraction, current, tiers, balance }) => {
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
          availableBalanceWei: balance,
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

  it("3a: after a reduce with no escalation, the RESULTING total outflow fits the budget", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        if (d.kind !== "reduce" || d.escalation !== null) return;
        const after = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
        for (const a of d.adjustments) after.set(a.receiver, a.toRateWeiPerSec);
        const total = [...after.values()].reduce((sum, r) => sum + r, 0n);
        const budget = facts.availableBalanceWei / policy.targetRunwaySec;
        expect(total <= budget).toBe(true);
      }),
    );
  });

  it("3b: after a reduce that escalates, every stream sits at or below its floor", () => {
    fc.assert(
      fc.property(scenario, ({ policy, facts }) => {
        const d = decide(facts, policy);
        if (d.kind !== "reduce" || d.escalation === null) return;
        const after = new Map(facts.streams.map((s) => [s.receiver, s.flowRateWeiPerSec]));
        for (const a of d.adjustments) after.set(a.receiver, a.toRateWeiPerSec);
        for (const r of policy.recipients) {
          expect((after.get(r.address) ?? 0n) <= r.floorRateWeiPerSec).toBe(true);
        }
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
