import { describe, expect, it } from "vitest";
import { idempotencyKey } from "../../src/keeperhub/idempotency.js";
import type { Address, Adjustment, Policy } from "../../src/policy/types.js";

function policy(): Policy {
  return {
    version: 1,
    chainId: 11155111,
    token: "0x0000000000000000000000000000000000000aaa" as Address,
    sender: "0x0000000000000000000000000000000000000bbb" as Address,
    minRunwaySec: 100n,
    targetRunwaySec: 200n,
    hysteresisSec: 50n,
    recipients: [],
    escalation: { webhook: "https://example.invalid/hook" },
  };
}

function adjustment(): Adjustment {
  return {
    receiver: "0x1111111111111111111111111111111111111111" as Address,
    fromRateWeiPerSec: 100n,
    toRateWeiPerSec: 50n,
    reason: "budget-shed",
  };
}

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
    const other = { ...adjustment(), receiver: "0x9999999999999999999999999999999999999999" as Address };
    expect(idempotencyKey(policy(), adjustment(), 1_700_000_000)).not.toBe(
      idempotencyKey(policy(), other, 1_700_000_000),
    );
  });

  it("differs for the same target rate reached from a different starting rate (I5)", () => {
    // adjustment() is 100 -> 50 (tick 1: lands, the stream recovers to 100).
    // Tick 3, still inside the same 6-hour bucket, reduces the *recovered*
    // 100 down to 50 again -- wait, that is the identical fromRate/toRate
    // pair. The actual collision this guards against is two DIFFERENT
    // starting rates landing on the same target: e.g. 80 -> 50 (a shallower
    // cut from a partially-recovered stream) versus 100 -> 50 (the original
    // cut). Same receiver, same target rate, same bucket, but genuinely
    // different work -- the on-chain state before each write differed.
    // Without fromRateWeiPerSec in the key material these collide, and
    // KeeperHub would replay one's stored response for the other: `landed`
    // with a transaction hash from a run that never touched this rate change.
    const cutFrom100 = adjustment(); // fromRate 100n -> toRate 50n
    const cutFrom80 = { ...adjustment(), fromRateWeiPerSec: 80n }; // fromRate 80n -> toRate 50n
    expect(idempotencyKey(policy(), cutFrom100, 1_700_000_000)).not.toBe(
      idempotencyKey(policy(), cutFrom80, 1_700_000_000),
    );
  });

  it("still dedupes a genuine retry: same fromRate, same toRate, same bucket", () => {
    const a = idempotencyKey(policy(), adjustment(), 1_700_000_000);
    const b = idempotencyKey(policy(), adjustment(), 1_700_000_050);
    expect(a).toBe(b);
  });
});
