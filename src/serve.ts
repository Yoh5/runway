import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildExecutorDeps,
  buildReaderDeps,
  notifyWebhook,
  readPolicy,
} from "./cli.js";
import { readFacts } from "./chain/reader.js";
import { executeAdjustment } from "./keeperhub/execute.js";
import { reason } from "./redact.js";
import { toSerialisable, type RunRecord } from "./runner/record.js";
import { runOnce, type RunDeps } from "./runner/run.js";
import { createTriggerHandler, type TriggerRequest } from "./trigger/handle.js";

/**
 * The HTTP carrier for the trigger. Everything that decides anything lives
 * in `trigger/handle.ts`; this file only turns sockets into the plain values
 * that module takes, and turns its answers back into responses.
 *
 * Run it with:
 *   pnpm serve
 *
 * and point a KeeperHub scheduled workflow's HTTP Request node at
 * `POST https://<host>/tick` with the header this file reads. See
 * docs/SCHEDULING.md.
 */

/**
 * Not `Authorization: Bearer`, deliberately. Hosting platforms, proxies and
 * log shippers treat `Authorization` as a thing to record or to rewrite, and
 * some strip it on redirect. A purpose-named header is carried through
 * untouched and is obvious in a workflow's configuration.
 */
const TOKEN_HEADER = "x-runway-token";

/**
 * Turns a raw request into the shape the handler takes. Exported because
 * this is the part with decisions in it -- a query string that must not
 * change which path was asked for, and a duplicated header that must not be
 * allowed to smuggle a second token past the comparison.
 */
export function toTriggerRequest(
  method: string | undefined,
  url: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): TriggerRequest {
  // `url` on a server request is origin-form ("/tick?x=1"), so the base here
  // is only there to satisfy the parser and never reaches the result.
  const parsed = new URL(url ?? "/", "http://placeholder.invalid");
  const raw = headers[TOKEN_HEADER];
  return {
    method: method ?? "",
    path: parsed.pathname,
    // An array means the header arrived more than once. Which one counts is
    // then a question about proxy behaviour rather than about this project,
    // so the answer is neither: an ambiguous credential is no credential.
    token: typeof raw === "string" ? raw : undefined,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See docs/SCHEDULING.md.`);
  }
  return value;
}

/**
 * One tick, wired to the real chain and the real KeeperHub, persisted the
 * same way the CLI persists it.
 *
 * The policy path comes from the environment and never from the request:
 * a body-supplied path would let anyone holding the token point the keeper
 * at a policy of their own choosing, which is a different treasury, a
 * different set of recipients and a different mandate.
 */
async function realTick(policyPath: string, log: (message: string) => void): Promise<RunRecord> {
  const policy = await readPolicy(policyPath);
  const nowSec = Math.floor(Date.now() / 1000);
  const readerDeps = buildReaderDeps();
  const executorDeps = buildExecutorDeps();
  const runDeps: RunDeps = {
    readFacts: (p, n) => readFacts(readerDeps, p, n),
    execute: (p, adjustment, n) => executeAdjustment(executorDeps, p, adjustment, n),
    notify: notifyWebhook,
  };

  const record = await runOnce(runDeps, policy, nowSec);
  const serialisable = toSerialisable(record);

  // Written to disk for a local run, and logged as one line because a
  // hosted filesystem is usually ephemeral -- on a platform that recycles
  // the instance, the log is the only copy that survives, and a run record
  // that only ever existed on a dead container is not evidence of anything.
  try {
    const runsDir = path.resolve("runs");
    await mkdir(runsDir, { recursive: true });
    const fileName = `${record.startedAt.replace(/[:.]/g, "-")}.json`;
    await writeFile(path.join(runsDir, fileName), JSON.stringify(serialisable, null, 2));
  } catch (error) {
    // A read-only filesystem must not turn a completed tick into a failed
    // one: the writes already happened on chain, and reporting failure here
    // would tell the scheduler to worry about something that went right.
    log(`serve: could not persist the run record to disk: ${reason(error)}`);
  }

  log(`serve: run ${JSON.stringify(serialisable)}`);
  return record;
}

export async function main(): Promise<void> {
  const token = requireEnv("RUNWAY_TRIGGER_TOKEN");
  const policyPath = process.env.RUNWAY_POLICY ?? "policies/treasury.sepolia.yaml";
  const port = Number(process.env.PORT ?? 8080);
  const log = (message: string) => {
    console.log(message);
  };

  const handle = createTriggerHandler({
    expectedToken: token,
    runTick: () => realTick(policyPath, log),
    log,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The body is not read at all: every input this endpoint accepts is in
    // the environment or the header, so there is nothing a caller can put in
    // a body that should change what happens.
    req.resume();
    void handle(toTriggerRequest(req.method, req.url, req.headers))
      .then(({ status, body }) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      })
      .catch((error: unknown) => {
        // The handler catches its own failures, so reaching here means the
        // handler itself broke. Answer rather than leaving the socket open
        // until the scheduler's own timeout.
        log(`serve: handler failed: ${reason(error)}`);
        const payload = JSON.stringify({ ok: false, code: "run-failed" });
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      });
  });

  server.listen(port, () => {
    log(`serve: listening on port ${port}, policy ${policyPath}`);
  });
}

// Same entrypoint guard as the CLI, for the same reason: importing this
// module must never start a server that can broadcast transactions.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(reason(error));
    process.exitCode = 1;
  });
}
