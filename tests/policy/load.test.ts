import { describe, expect, it } from "vitest";
import { loadPolicy, PolicyError } from "../../src/policy/load.js";
import { UNRESOLVED_WEBHOOK_PREFIX } from "../../src/policy/types.js";

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

describe("loadPolicy -- the escalation webhook read from the environment", () => {
  const withHook = (value: string) =>
    VALID.replace('webhook: "https://example.invalid/hook"', `webhook: "${value}"`);

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} form is the policy syntax under test, not an unfinished template
  it("expands ${VAR} from the supplied environment, so a private URL never lands in the committed policy", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: policy syntax, not a template
    const policy = loadPolicy(withHook("${ESCALATION_WEBHOOK}"), {
      ESCALATION_WEBHOOK: "https://hooks.runway-ops.dev/escalations",
    });
    expect(policy.escalation.webhook).toBe("https://hooks.runway-ops.dev/escalations");
  });

  it("marks an unset variable unresolved by name, so a read-only script still loads the policy", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: policy syntax, not a template
    const policy = loadPolicy(withHook("${ESCALATION_WEBHOOK}"), {});
    expect(policy.escalation.webhook).toBe(`${UNRESOLVED_WEBHOOK_PREFIX}ESCALATION_WEBHOOK`);
  });

  it("treats a variable that is set but empty exactly like an unset one", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: policy syntax, not a template
    const policy = loadPolicy(withHook("${ESCALATION_WEBHOOK}"), { ESCALATION_WEBHOOK: "" });
    expect(policy.escalation.webhook).toBe(`${UNRESOLVED_WEBHOOK_PREFIX}ESCALATION_WEBHOOK`);
  });

  it("leaves a literal URL untouched", () => {
    const policy = loadPolicy(withHook("https://hooks.runway-ops.dev/escalations"), {});
    expect(policy.escalation.webhook).toBe("https://hooks.runway-ops.dev/escalations");
  });
});
