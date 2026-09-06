/**
 * Turns any thrown value into safe display text. Every module that reports
 * why something failed needs this (`chain/reader.ts`, `keeperhub/execute.ts`,
 * `runner/run.ts`, `cli.ts` all defined an identical copy before this module
 * existed); extracted once so there is exactly one place that decides how an
 * unknown thrown value becomes a string.
 */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strips every secret in `secrets` out of `text`, replacing each occurrence
 * with `[redacted]`. Falsy or empty entries are skipped, so a caller can pass
 * an optional secret it may not have (e.g. an `ExecutorDeps.rpcUrl` a test
 * double never set) without special-casing it.
 *
 * A secret an underlying client (viem, fetch) embeds in its own thrown error
 * message must never survive into a failure reason, an escalation detail, a
 * serialised run record, or the escalation webhook payload -- including a
 * hosted RPC provider's key, which travels baked into the URL path itself
 * (e.g. `https://eth-sepolia.g.alchemy.com/v2/<KEY>`) rather than as
 * basic-auth credentials, so viem's own credential stripping never touches
 * it.
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}
