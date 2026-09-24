import type { Address, Policy } from "../policy/types.js";
import { reason } from "../redact.js";

/**
 * One assumption this integration rests on, and whether it still holds right
 * now. A check never repairs anything and never writes: it states what it
 * observed, so a scheduled run of these turns "it worked in September" into
 * "it works today".
 */
export type Check = { name: string; ok: boolean; detail: string };

/** An execution this repository recorded, and the hash it recorded for it. */
export type RecordedExecution = { executionId: string; transactionHash: string };

export type ConformanceDeps = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  apiKey: string;
  flowOperator: Address;
  /** Bytecode at an address, `"0x"` or undefined when nothing is deployed. */
  getCode: (address: Address) => Promise<string | undefined>;
  getFlowOperatorPermissions: (args: {
    token: Address;
    sender: Address;
    flowOperator: Address;
  }) => Promise<{ permissions: number; flowrateAllowanceWeiPerSec: bigint }>;
};

/**
 * `update | delete`, and deliberately not `create`. The one number in this
 * file that is a design decision rather than an observation: a mandate that
 * grew a create bit would let the keeper open a stream, which is the single
 * thing it must never be able to do — so a widened mandate fails this check
 * exactly as loudly as a revoked one.
 */
const EXPECTED_PERMISSIONS = 6;

/**
 * Posted to an action that does not exist, to prove the 401 on the real route
 * is about authentication and not a server answering 401 to everything.
 */
const UNKNOWN_ACTION = "superfluid/runway-conformance-probe";

const CFA_FORWARDER_ADDRESS = "0xcfA132E353cB4E398080B9700609bb008eceB125" as Address;

/** Runs one probe, turning any throw into a failed check instead of ending the run. */
async function check(name: string, probe: () => Promise<Check>): Promise<Check> {
  try {
    return await probe();
  } catch (error) {
    return { name, ok: false, detail: reason(error) };
  }
}

/**
 * Every check is read-only. The two POSTs carry no credentials and an empty
 * body, to an action that cannot execute (unauthenticated) and to one that
 * does not exist — nothing here can move a rate or spend gas, which is what
 * makes it safe to run on a schedule against production.
 */
export async function runConformance(
  deps: ConformanceDeps,
  policy: Policy,
  executions: RecordedExecution[],
): Promise<Check[]> {
  const anonymousPost = (action: string) =>
    deps.fetch(`${deps.baseUrl}/api/execute/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

  const checks: Check[] = [];

  checks.push(
    await check("keeperhub-route-exists", async () => {
      const response = await anonymousPost("superfluid/update-flow");
      if (response.status === 401 || response.status === 403) {
        return {
          name: "keeperhub-route-exists",
          ok: true,
          detail: `route present, anonymous caller refused with http ${response.status}`,
        };
      }
      if (response.ok) {
        return {
          name: "keeperhub-route-exists",
          ok: false,
          detail: `anonymous execute was accepted with http ${response.status}`,
        };
      }
      return {
        name: "keeperhub-route-exists",
        ok: false,
        detail: `expected 401 from the execute route, got http ${response.status}`,
      };
    }),
  );

  checks.push(
    await check("keeperhub-unknown-action-refused", async () => {
      const response = await anonymousPost(UNKNOWN_ACTION);
      const ok = response.status === 404;
      return {
        name: "keeperhub-unknown-action-refused",
        ok,
        detail: ok
          ? "an unknown action is a 404, so the 401 above is authentication and not a catch-all"
          : `expected 404 for an unknown action, got http ${response.status}`,
      };
    }),
  );

  checks.push(
    await check("keeperhub-execution-retrievable", async () => {
      const failures: string[] = [];
      for (const execution of executions) {
        const response = await deps.fetch(
          `${deps.baseUrl}/api/execute/${execution.executionId}/status`,
          { headers: { Authorization: `Bearer ${deps.apiKey}` } },
        );
        if (!response.ok) {
          failures.push(`${execution.executionId}: http ${response.status}`);
          continue;
        }
        const body = (await response.json()) as { status?: string; transactionHash?: string };
        if (body.transactionHash !== execution.transactionHash) {
          failures.push(
            `${execution.executionId}: hash ${body.transactionHash ?? "absent"} does not match the recorded ${execution.transactionHash}`,
          );
          continue;
        }
        if (body.status !== "completed") {
          failures.push(`${execution.executionId}: status ${body.status ?? "absent"}`);
        }
      }
      return {
        name: "keeperhub-execution-retrievable",
        ok: failures.length === 0,
        detail:
          failures.length === 0
            ? `${executions.length} recorded execution(s) still retrievable, same hashes`
            : failures.join("; "),
      };
    }),
  );

  const mandate = await deps
    .getFlowOperatorPermissions({
      token: policy.token,
      sender: policy.sender,
      flowOperator: deps.flowOperator,
    })
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, detail: reason(error) }));

  if (mandate.ok) {
    const { permissions, flowrateAllowanceWeiPerSec } = mandate.value;
    checks.push({
      name: "mandate-permissions",
      ok: permissions === EXPECTED_PERMISSIONS,
      detail:
        permissions === EXPECTED_PERMISSIONS
          ? "permissions 6: update and delete, never create"
          : `permissions ${permissions}, expected ${EXPECTED_PERMISSIONS} (update | delete)`,
    });

    // A restore walks rates back toward their committed values, so an
    // allowance below their sum means the mandate can no longer honour the
    // half of the policy nobody notices until the treasury recovers.
    const committed = policy.recipients.reduce((sum, r) => sum + r.committedRateWeiPerSec, 0n);
    checks.push({
      name: "mandate-allowance",
      ok: flowrateAllowanceWeiPerSec >= committed,
      detail: `allowance ${flowrateAllowanceWeiPerSec} wei/sec against ${committed} committed`,
    });
  } else {
    checks.push({ name: "mandate-permissions", ok: false, detail: mandate.detail });
    checks.push({ name: "mandate-allowance", ok: false, detail: mandate.detail });
  }

  checks.push(
    await check("forwarder-deployed", async () => {
      const code = await deps.getCode(CFA_FORWARDER_ADDRESS);
      const deployed = Boolean(code) && code !== "0x";
      return {
        name: "forwarder-deployed",
        ok: deployed,
        detail: deployed
          ? `CFAv1Forwarder holds ${(code as string).length} characters of bytecode`
          : `no code at ${CFA_FORWARDER_ADDRESS}`,
      };
    }),
  );

  return checks;
}
