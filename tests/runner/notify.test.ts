import { describe, expect, it } from "vitest";
import {
  assertDeliverableEscalation,
  createWebhookNotifier,
  isPlaceholderWebhook,
} from "../../src/runner/notify.js";
import { UNRESOLVED_WEBHOOK_PREFIX } from "../../src/policy/types.js";

const HOOK = "https://hooks.runway-ops.dev/escalations";

type Call = { url: string; init: RequestInit };

/** Records every request so a test can assert on what actually went out. */
function recorder(responses: (Response | Error)[]): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

/** Reads one element, failing the test loudly rather than asserting on undefined. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}`);
  return item;
}

const ok = () => new Response(null, { status: 204 });
const status = (code: number) => new Response("", { status: code });

describe("createWebhookNotifier", () => {
  it("posts the escalation as JSON to the policy's webhook", async () => {
    const { calls, fetch } = recorder([ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify(HOOK, { kind: "floors-exceed-budget", detail: "79664745201 wei/sec above budget" });

    expect(calls).toHaveLength(1);
    expect(at(calls, 0).url).toBe(HOOK);
    expect(at(calls, 0).init.method).toBe("POST");
    expect(JSON.parse(String(at(calls, 0).init.body))).toEqual({
      kind: "floors-exceed-budget",
      detail: "79664745201 wei/sec above budget",
    });
  });

  it("carries an abort signal, so a webhook that never answers cannot hold the tick open", async () => {
    const { calls, fetch } = recorder([ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify(HOOK, { kind: "read-incomplete", detail: "rpc timed out" });

    expect(at(calls, 0).init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a network failure and succeeds on a later attempt", async () => {
    const { calls, fetch } = recorder([new Error("socket hang up"), ok()]);
    const waits: number[] = [];
    const notify = createWebhookNotifier({
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await notify(HOOK, { kind: "mandate-rejected", detail: "refused" });

    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(at(waits, 0)).toBeGreaterThan(0);
  });

  it("retries a 503, because an endpoint that is briefly down will come back", async () => {
    const { calls, fetch } = recorder([status(503), ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify(HOOK, { kind: "read-incomplete", detail: "rpc timed out" });

    expect(calls).toHaveLength(2);
  });

  it("does not retry a 404: a wrong URL does not fix itself, and the run record must say so now", async () => {
    const { calls, fetch } = recorder([status(404)]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await expect(notify(HOOK, { kind: "read-incomplete", detail: "x" })).rejects.toThrow(/404/);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the attempt budget and throws, so the escalation is recorded as undelivered", async () => {
    const { calls, fetch } = recorder([status(500)]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {}, attempts: 3 });

    await expect(notify(HOOK, { kind: "read-incomplete", detail: "x" })).rejects.toThrow(/500/);
    expect(calls).toHaveLength(3);
  });

  it("backs off further on each attempt rather than hammering a struggling endpoint", async () => {
    const { fetch } = recorder([status(500)]);
    const waits: number[] = [];
    const notify = createWebhookNotifier({
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      attempts: 3,
    });

    await expect(notify(HOOK, { kind: "read-incomplete", detail: "x" })).rejects.toThrow();

    expect(waits).toHaveLength(2);
    expect(at(waits, 1)).toBeGreaterThan(at(waits, 0));
  });
});

describe("isPlaceholderWebhook", () => {
  it("recognises the URL the policy template ships with", () => {
    expect(isPlaceholderWebhook("https://example.invalid/hook")).toBe(true);
  });

  it("recognises the other reserved example hosts", () => {
    expect(isPlaceholderWebhook("https://example.com/hook")).toBe(true);
    expect(isPlaceholderWebhook("http://localhost:9999/hook")).toBe(true);
  });

  it("accepts a real endpoint", () => {
    expect(isPlaceholderWebhook(HOOK)).toBe(false);
  });

  it("treats an unparseable URL as a placeholder rather than assuming it will deliver", () => {
    expect(isPlaceholderWebhook("not a url")).toBe(true);
  });

  it("treats anything that is not http(s) as a placeholder -- a webhook is posted to, not dialled", () => {
    expect(isPlaceholderWebhook("ftp://hooks.runway-ops.dev/escalations")).toBe(true);
  });

  it("recognises an unresolved environment variable", () => {
    expect(isPlaceholderWebhook(`${UNRESOLVED_WEBHOOK_PREFIX}ESCALATION_WEBHOOK`)).toBe(true);
  });
});

describe("assertDeliverableEscalation", () => {
  it("refuses a placeholder, naming the field an operator has to fix", () => {
    expect(() => assertDeliverableEscalation("https://example.invalid/hook")).toThrow(
      /escalation\.webhook/,
    );
  });

  it("passes a real endpoint through without throwing", () => {
    expect(() => assertDeliverableEscalation(HOOK)).not.toThrow();
  });

  it("names the environment variable to set when that is what is missing", () => {
    expect(() =>
      assertDeliverableEscalation(`${UNRESOLVED_WEBHOOK_PREFIX}ESCALATION_WEBHOOK`),
    ).toThrow(/ESCALATION_WEBHOOK is not set/);
  });
});

describe("createWebhookNotifier -- the body each destination actually accepts", () => {
  const body = (calls: Call[]) => JSON.parse(String(at(calls, 0).init.body));

  it("sends Discord a `content` field, since Discord rejects a body without one", async () => {
    const { calls, fetch } = recorder([ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify("https://discord.com/api/webhooks/1/abc", {
      kind: "floors-exceed-budget",
      detail: "79664745201 wei/sec above budget",
    });

    expect(body(calls).content).toContain("floors-exceed-budget");
    expect(body(calls).content).toContain("79664745201 wei/sec above budget");
  });

  it("sends Slack a `text` field", async () => {
    const { calls, fetch } = recorder([ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify("https://hooks.slack.com/services/T/B/x", {
      kind: "mandate-rejected",
      detail: "one or more adjustments were refused",
    });

    expect(body(calls).text).toContain("mandate-rejected");
  });

  it("leaves any other endpoint the raw escalation, which is what a receiver of our own parses", async () => {
    const { calls, fetch } = recorder([ok()]);
    const notify = createWebhookNotifier({ fetch, sleep: async () => {} });

    await notify(HOOK, { kind: "read-incomplete", detail: "rpc timed out" });

    expect(body(calls)).toEqual({ kind: "read-incomplete", detail: "rpc timed out" });
  });
});
