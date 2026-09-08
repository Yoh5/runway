import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvidenceBundle } from "../../scripts/lib/capture-evidence.js";

/**
 * The gate for `docs/EVIDENCE.md`: no figure in that document is trusted
 * unless this test reads it back off `docs/evidence/run.json`, the curated
 * record `scripts/capture-evidence.ts` produces from the one live
 * demonstration run. This is the defect class spec section 10 names --
 * a number written into a document by hand, never checked against the
 * source that produced it.
 *
 * Deliberately excluded from `pnpm test` (see vitest.config.ts's `exclude`
 * and vitest.evidence.config.ts) -- run it with `pnpm test:evidence`. It
 * stays red until the live Sepolia run happens and its evidence is
 * captured; a red test living inside the main suite trains people to
 * ignore red, which is worse than a gate nobody runs by accident.
 */
const RUN_JSON_PATH = path.resolve("docs/evidence/run.json");
const EVIDENCE_MD_PATH = path.resolve("docs/EVIDENCE.md");

/**
 * The exact sentinel `docs/EVIDENCE.md` ships with in every value slot. No
 * real transaction hash, block number, rate or gas figure can ever equal
 * this string -- it exists purely so this test can fail loudly as long as
 * the document has not been rewritten with real values.
 */
const SENTINEL = "SENTINEL-NOT-A-REAL-VALUE";

async function readRunJsonOrExplain(): Promise<string> {
  try {
    return await readFile(RUN_JSON_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "docs/evidence/run.json does not exist -- the live Sepolia demonstration has not been " +
          "captured yet. Run the live tick, then `pnpm tsx scripts/capture-evidence.ts " +
          "<path-to-the-run-record>` to produce it, then re-run `pnpm test:evidence`. This failure " +
          "is deliberate: it is the gate that stops docs/EVIDENCE.md from shipping a fabricated " +
          "number, not a bug in this test.",
      );
    }
    throw error;
  }
}

describe("docs/EVIDENCE.md is gated against docs/evidence/run.json", () => {
  it("rejects the sentinel and quotes every figure the captured run record actually produced", async () => {
    const rawText = await readRunJsonOrExplain();
    const bundle = parseEvidenceBundle(rawText);
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");

    if (doc.includes(SENTINEL)) {
      throw new Error(
        `docs/EVIDENCE.md still contains the sentinel "${SENTINEL}" in at least one value slot. ` +
          "That sentinel is deliberate -- it exists so this test fails until every real value is " +
          "filled in. Replace every occurrence with the matching figure read from " +
          "docs/evidence/run.json (this test parses exactly those figures out of it below), then " +
          "re-run `pnpm test:evidence`.",
      );
    }

    expect(doc, "block number").toContain(bundle.evidence.blockNumber);

    let landedCount = 0;
    for (const entry of bundle.record.outcomes) {
      if (entry.outcome.status !== "landed") continue;
      landedCount += 1;
      const { outcome, adjustment } = entry;
      const who = adjustment.receiver;

      expect(doc, `transaction hash for ${who}`).toContain(outcome.transactionHash);
      expect(doc, `explorer link for ${who}`).toContain(outcome.transactionLink);

      const gasPaidWei = (BigInt(outcome.gasUsedWei) * BigInt(outcome.effectiveGasPriceWei)).toString();
      expect(doc, `gas paid for ${who}`).toContain(gasPaidWei);

      // Absence must read as "not stated", never coerced to "false" -- see
      // docs/EVIDENCE.md's own prose on this, which a sibling test asserts
      // is present.
      const sponsoredText = outcome.sponsored === undefined ? "not stated" : String(outcome.sponsored);
      expect(doc, `sponsored status for ${who}`).toContain(sponsoredText);

      const verified = bundle.evidence.verifiedRates.find(
        (v) => v.receiver.toLowerCase() === who.toLowerCase(),
      );
      // parseEvidenceBundle already guarantees this exists for every landed
      // outcome; this guard only narrows the type for what follows.
      if (!verified) {
        throw new Error(`no verified rate for ${who} -- parseEvidenceBundle should have rejected this already`);
      }
      expect(doc, `rate before, for ${who}`).toContain(verified.beforeWeiPerSec);
      expect(doc, `rate after, for ${who}`).toContain(verified.afterWeiPerSec);
    }

    // parseEvidenceBundle throws before this point if there is no landed
    // outcome at all; this is the belt to that suspenders; it also
    // documents, for a reader of this test, that at least one figure was
    // actually checked above rather than the loop body having run zero times.
    expect(landedCount, "at least one landed outcome to have evidence about").toBeGreaterThan(0);
  });

  it('states in prose that an absent "sponsored" field means "not stated", not "not sponsored"', async () => {
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");
    expect(doc).toMatch(/not\s+stated/i);
    expect(doc).toMatch(/not\s+sponsored/i);
    expect(doc.toLowerCase()).toContain("sender that is not our");
  });

  it("states in prose that a mined receipt proves landing, not that the stream actually changed", async () => {
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");
    expect(doc.toLowerCase()).toMatch(/mined receipt/);
    expect(doc.toLowerCase()).toMatch(/chain read/);
  });
});
