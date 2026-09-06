import { createHash } from "node:crypto";
import type { Adjustment, Policy } from "../policy/types.js";

/**
 * KeeperHub replays a stored response for 24 hours and then silently executes
 * the same key again. A 6-hour bucket keeps a retry inside one window while
 * guaranteeing the key has rotated well before the replay window expires.
 *
 * The key deliberately excludes the run: that is what makes a retry of the
 * *same* intent (same tick, same in-flight write) dedupe against the
 * original instead of double-sending. But two *different* writes that happen
 * to target the same rate inside one bucket must not collide just because
 * `toRateWeiPerSec` and the bucket match: tick 1 reduces a stream from 100 to
 * 50 and lands; the rate recovers to 100; tick 3, still inside the same
 * 6-hour bucket, reduces it from 100 to 50 again -- genuinely new work, since
 * the stream had to be raised back up in between. Without `fromRateWeiPerSec`
 * in the key material, KeeperHub would see the identical key, replay the
 * stored response from tick 1, and the executor would report `landed` with a
 * transaction hash from a run that never touched this rate change -- nothing
 * written, the stream still at 100, and the run record showing evidence from
 * another run, for up to six hours while the balance drains. Including the
 * observed starting rate fixes this: a genuine retry of the same tick still
 * sees the same `fromRate` and dedupes correctly, but two writes starting
 * from different rates are different work and get different keys.
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
    adjustment.fromRateWeiPerSec.toString(),
    adjustment.toRateWeiPerSec.toString(),
    String(bucket),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
