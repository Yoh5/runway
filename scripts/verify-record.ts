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
 * Exits non-zero if any record fails, so a scheduler can alert on it — and
 * also when a directory named on the command line turns out to hold nothing,
 * because a gate that passes on an empty room is not a gate.
 */

import { readFileSync, readdirSync } from "node:fs";
import { loadPolicy } from "../src/policy/load.js";
import { policyDigest } from "../src/runner/verify.js";
import { verifyRunsDirectory } from "./lib/verify-record.js";

const POLICY_PATH = process.argv[2] ?? "policies/treasury.sepolia.yaml";
const RUNS_DIR = process.argv[3] ?? "runs";

function main(): void {
  const policy = loadPolicy(readFileSync(POLICY_PATH, "utf-8"));
  console.log(`policy: ${POLICY_PATH}`);
  console.log(`digest: ${policyDigest(policy)}`);
  console.log("");

  const outcome = verifyRunsDirectory({
    policy,
    dir: RUNS_DIR,
    explicit: process.argv[3] !== undefined,
    list: (dir) => readdirSync(dir),
    read: (file) => readFileSync(file, "utf-8"),
  });

  for (const verdict of outcome.verdicts) {
    console.log(`${verdict.ok ? "PASS" : "FAIL"}  ${verdict.startedAt}  ${verdict.detail}`);
  }

  if (outcome.verdicts.length > 0) console.log("");
  console.log(outcome.summary);
  if (!outcome.ok) process.exitCode = 1;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
