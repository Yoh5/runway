/**
 * Prints presence booleans only -- never a value, never a prefix, never a
 * length. A prefix or a length can narrow a secret; this script exists so a
 * human can confirm the Sepolia setup variables are exported before running
 * anything else, without that confirmation ever becoming a leak.
 *
 * ESCALATION_WEBHOOK is on the list because a write-mode tick refuses to
 * start without it: an agent that can throttle someone's pay has to be able
 * to tell a human when it stops, and the 8 September 2026 run escalated into
 * a placeholder host and reached nobody.
 */
const NAMES = [
  "KEEPERHUB_API_KEY",
  "KEEPERHUB_BASE_URL",
  "SEPOLIA_RPC_URL",
  "KEEPERHUB_FLOW_OPERATOR_ADDRESS",
  "ESCALATION_WEBHOOK",
] as const;

let allPresent = true;
for (const name of NAMES) {
  const present = Boolean(process.env[name]);
  if (!present) allPresent = false;
  console.log(`${name}: ${present ? "present" : "MISSING"}`);
}

if (!allPresent) process.exitCode = 1;
