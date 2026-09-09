import { createHash, timingSafeEqual } from "node:crypto";
import { reason } from "../redact.js";
import type { RunRecord } from "../runner/record.js";

/**
 * The HTTP trigger's decision-making, with no socket anywhere near it.
 *
 * This exists so a scheduler can run a tick without a person at a keyboard,
 * which is the difference between a keeper that works and a keeper that
 * watches. It is also the only surface in this project that lets something
 * other than its owner move money, so it is written to refuse first: an
 * unknown path, an unknown method, a missing or wrong token and a tick
 * already in flight are each rejected before `runTick` is reachable.
 *
 * Kept separate from the server that carries it (`src/serve.ts`) for the
 * reason the rest of this codebase separates decisions from I/O: every
 * refusal below is asserted in a test that never opens a port.
 */

export type TriggerRequest = {
  method: string;
  /** Path only -- no query string, no host. */
  path: string;
  /** Whatever arrived in the auth header, or undefined if it was absent. */
  token: string | undefined;
};

export type TriggerBody = {
  /**
   * Whether the request did what it asked for.
   *
   * Present on every response, including the successful ones, because of how
   * the thing calling this reads it: KeeperHub's HTTP Request step
   * (`lib/workflow/codegen/templates/http-request.ts`) returns the parsed
   * body and never looks at `response.ok` or the status code. A workflow
   * therefore cannot see a `401` or a `500` at all -- to a condition node,
   * an error body and a success body are both just "the step returned an
   * object". Stating the outcome inside the body is what makes a failed
   * tick detectable by the scheduler that triggered it.
   */
  ok: boolean;
  /** Machine-readable outcome: the thing a workflow condition should branch on. */
  code: "ok" | "unauthorized" | "not-found" | "method-not-allowed" | "in-progress" | "run-failed";
  /** Present only when a tick actually ran to completion. */
  result?: TickSummary;
  /** Present only on failure, already passed through `reason`. */
  error?: string;
};

export type TickSummary = {
  startedAt: string;
  /** The decision's kind, or null when the run never reached one (a failed read). */
  decision: string | null;
  /**
   * Seconds of runway at decision time, as a decimal string.
   *
   * `null` carries two different meanings, told apart by `decision`: with
   * `decision: null` the run never got far enough to compute one, and with a
   * decision present it means the treasury has no net outflow, so the runway
   * is unbounded rather than unknown. `decide` returns `null` for exactly
   * that case, and collapsing it to `"0"` here would report the healthiest
   * possible treasury as the most urgent one.
   */
  runwaySec: string | null;
  breach: boolean | null;
  adjustments: number;
  writes: { receiver: string; status: string; transactionHash?: string }[];
  escalations: { kind: string; delivered: boolean }[];
};

export type TriggerDeps = {
  /** The shared secret a caller must present. */
  expectedToken: string;
  /** Runs one tick and persists it. Everything this module knows about the chain. */
  runTick: () => Promise<RunRecord>;
  log: (message: string) => void;
};

/**
 * Long enough that guessing is not a strategy, and short enough that any
 * real generated secret clears it. The point of the check is to fail closed
 * on an unset or half-configured environment variable: an empty string that
 * reaches `equalTokens` would otherwise authenticate every caller who also
 * sends nothing.
 */
const MIN_TOKEN_LENGTH = 32;

const TICK_PATH = "/tick";
const HEALTH_PATH = "/health";

/**
 * Compares two secrets without leaking their contents through how long the
 * comparison takes. Both sides are hashed first so `timingSafeEqual` always
 * gets equal-length buffers -- it throws on a length mismatch, and that throw
 * would itself be a length oracle.
 */
function equalTokens(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function summarise(record: RunRecord): TickSummary {
  return {
    startedAt: record.startedAt,
    decision: record.decision?.kind ?? null,
    runwaySec: record.decision?.runwaySec?.toString() ?? null,
    breach: record.decision ? record.decision.breach : null,
    adjustments: record.decision?.adjustments.length ?? 0,
    writes: record.outcomes.map((entry) => ({
      receiver: entry.adjustment.receiver,
      status: entry.outcome.status,
      // Present on a landed write, and on an unresolved one that carries a
      // hash -- the state where the treasury may have paid and this run
      // cannot say. Absent means there is no hash to look up, never that
      // nothing was broadcast.
      ...("transactionHash" in entry.outcome && entry.outcome.transactionHash
        ? { transactionHash: entry.outcome.transactionHash }
        : {}),
    })),
    escalations: record.escalations.map((e) => ({ kind: e.kind, delivered: e.delivered })),
  };
}

/**
 * Builds the handler. State lives in the closure rather than at module
 * scope so each caller -- and each test -- gets its own lock instead of
 * sharing one through the module registry.
 */
export function createTriggerHandler(
  deps: TriggerDeps,
): (request: TriggerRequest) => Promise<{ status: number; body: TriggerBody }> {
  if (deps.expectedToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `the trigger token must be at least ${MIN_TOKEN_LENGTH} characters; refusing to start with a weak or unset one`,
    );
  }

  // A scheduler that fires every 15 minutes will eventually fire while the
  // previous tick is still broadcasting. Two ticks reading the same facts
  // derive the same idempotency keys and so would mostly collide server-side
  // rather than double-spend -- but "mostly" is not a property to rely on
  // for money, and a second tick costs a full set of chain reads to discover
  // it has nothing new to say.
  let inFlight = false;

  return async function handle(request) {
    if (request.method === "GET" && request.path === HEALTH_PATH) {
      // Deliberately unauthenticated and deliberately says nothing: a
      // platform health check must not need the secret, and must not become
      // a way to learn whether the keeper is mid-tick.
      return { status: 200, body: { ok: true, code: "ok" } };
    }

    if (request.path !== TICK_PATH) {
      return { status: 404, body: { ok: false, code: "not-found" } };
    }

    if (request.method !== "POST") {
      return { status: 405, body: { ok: false, code: "method-not-allowed" } };
    }

    if (request.token === undefined || !equalTokens(request.token, deps.expectedToken)) {
      // No detail: a caller who got the token wrong learns only that they
      // got it wrong. The log line is for the operator, and names neither
      // the presented token nor the expected one.
      deps.log("trigger: rejected an unauthorised tick request");
      return { status: 401, body: { ok: false, code: "unauthorized" } };
    }

    if (inFlight) {
      deps.log("trigger: refused a tick because one is already running");
      return { status: 409, body: { ok: false, code: "in-progress" } };
    }

    inFlight = true;
    try {
      const record = await deps.runTick();
      return { status: 200, body: { ok: true, code: "ok", result: summarise(record) } };
    } catch (error) {
      // A tick that fails on a schedule fails with nobody watching, so the
      // reason has to travel back to whoever triggered it rather than only
      // into a log nobody reads. `reason` is the same one-line conversion
      // the rest of the project uses; the runner has already redacted its
      // secrets out of the message before it can get here.
      const detail = reason(error);
      deps.log(`trigger: tick failed: ${detail}`);
      return { status: 500, body: { ok: false, code: "run-failed", error: detail } };
    } finally {
      // Always released. A lock that survives a failed tick silently ends
      // the keeper: every later schedule answers "in-progress" for ever,
      // and the treasury drains while the endpoint keeps answering.
      inFlight = false;
    }
  };
}
