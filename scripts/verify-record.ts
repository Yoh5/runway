/**
 * Re-decides every recorded run from the facts it recorded, and checks that
 * the decision it claims is the one the policy actually produces.
 *
 * A run record says what happened. This says something stronger, and it is
 * the part an auditor cares about: what happened follows from what was seen,
 * by a rule anyone holding the policy file can apply for themselves. And in
 * the other direction — every write executed maps to an adjustment the
 * decision named, so no transaction can hide in the record without a decision
 * behind it.
 *
 * Reads files only. No chain, no network, no keys.
 *
 *   node --import tsx scripts/verify-record.ts [policy.yaml] [runs-dir]
 *
 * Exits non-zero if any record fails, so a scheduler can alert on it.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadPolicy } from "../src/policy/load.js";
import { fromSerialisable } from "../src/runner/record.js";
import { policyDigest, verifyRecord } from "../src/runner/verify.js";

const POLICY_PATH = process.argv[2] ?? "policies/treasury.sepolia.yaml";
const RUNS_DIR = process.argv[3] ?? "runs";

function main(): void {
  const policy = loadPolicy(readFileSync(POLICY_PATH, "utf-8"));
  console.log(`policy: ${POLICY_PATH}`);
  console.log(`digest: ${policyDigest(policy)}`);
  console.log("");

  let entries: string[];
  try {
    entries = readdirSync(RUNS_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    console.log(`no runs directory at ${RUNS_DIR}; nothing to verify`);
    return;
  }

  const verdicts = entries
    .sort()
    .map((entry) =>
      verifyRecord(
        fromSerialisable(JSON.parse(readFileSync(path.join(RUNS_DIR, entry), "utf-8"))),
        policy,
      ),
    );

  for (const verdict of verdicts) {
    console.log(`${verdict.ok ? "PASS" : "FAIL"}  ${verdict.startedAt}  ${verdict.detail}`);
  }

  const failed = verdicts.filter((v) => !v.ok).length;
  console.log("");
  console.log(`${verdicts.length - failed}/${verdicts.length} records verified`);
  if (failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
