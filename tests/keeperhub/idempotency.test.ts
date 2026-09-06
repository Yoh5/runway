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
});
