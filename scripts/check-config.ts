/**
 * Prints presence booleans only -- never a value, never a prefix, never a
 * length. A prefix or a length can narrow a secret; this script exists so a
 * human can confirm the four Sepolia setup variables are exported before
 * running anything else, without that confirmation ever becoming a leak.
 */
const NAMES = [
  "KEEPERHUB_API_KEY",
  "KEEPERHUB_BASE_URL",
  "SEPOLIA_RPC_URL",
  "KEEPERHUB_FLOW_OPERATOR_ADDRESS",
] as const;

let allPresent = true;
for (const name of NAMES) {
  const present = Boolean(process.env[name]);
  if (!present) allPresent = false;
  console.log(`${name}: ${present ? "present" : "MISSING"}`);
}

if (!allPresent) process.exitCode = 1;
