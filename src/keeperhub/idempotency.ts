import { createHash } from "node:crypto";
import type { Adjustment, Policy } from "../policy/types.js";

/**
 * KeeperHub replays a stored response for 24 hours and then silently executes
 * the same key again. A 6-hour bucket keeps a retry inside one window while
 * guaranteeing the key has rotated well before the replay window expires.
 */
const BUCKET_SEC = 6 * 3600;

export function idempotencyKey(
  policy: Policy,
  adjustment: Adjustment,
  nowSec: number,
): string {
  const bucket = Math.floor(nowSec / BUCKET_SEC);
  const material = [
    "runway.v1",
    String(policy.chainId),
    policy.token,
    policy.sender,
    adjustment.receiver,
    adjustment.toRateWeiPerSec.toString(),
    String(bucket),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
