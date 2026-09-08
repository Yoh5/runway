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

      // Absence must read as "not reported", never coerced to a false zero.
      // KeeperHub's new (status-bearing) response contract carries no gas
      // figures at all, so this is the common case there, not an edge one --
      // `BigInt("")` is `0n`, not a throw, so a naive product here would
      // silently write "Gas paid: 0" into the document, which reads as "this
      // transaction was free" when the truth is "the response did not say".
      const gasPaidText =
        outcome.gasUsedWei !== undefined && outcome.effectiveGasPriceWei !== undefined
          ? (BigInt(outcome.gasUsedWei) * BigInt(outcome.effectiveGasPriceWei)).toString()
          : "not reported";
      expect(doc, `gas paid for ${who}`).toContain(gasPaidText);

      // Absence must read as "not stated", never coerced to "false" -- see
      // docs/EVIDENCE.md's own prose on this, which a sibling test asserts
      // is present.
      const sponsoredText = outcome.sponsored === undefined ? "not stated" : String(outcome.sponsored);
      expect(doc, `sponsored status for ${who}`).toContain(sponsoredText);

      // Which KeeperHub response contract produced this outcome must be
      // stated outright in the document, not left for a reader to infer
      // from a field's absence the way `sponsored` above legitimately is --
      // the executor now tags every outcome from either contract
      // (src/keeperhub/execute.ts), so a landed outcome from a real run
      // always has one. A missing `contract` here means the run record
      // predates that tagging, or something upstream regressed -- either
      // way this must fail loudly rather than silently accept "not stated"
      // for a field the executor is now supposed to always fill in.
      if (outcome.contract === undefined) {
        throw new Error(
          `landed outcome for ${who} has no "contract" field -- every outcome must state which ` +
            "KeeperHub response contract it saw (see src/keeperhub/execute.ts's ResponseContract); " +
            "re-capture this run with an up-to-date executor",
        );
      }
      expect(doc, `response contract for ${who}`).toContain(outcome.contract);

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

  it('states in prose that an absent gas figure means "not reported", never a false zero', async () => {
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");
    expect(doc.toLowerCase()).toMatch(/not\s+reported/);
    // The document must connect that phrase to gas specifically, not just
    // use it somewhere unrelated. Matched across the paragraph, not just one
    // line -- the source wraps this prose across several lines of markdown.
    expect(doc.toLowerCase()).toMatch(/gas[\s\S]{0,400}not\s+reported|not\s+reported[\s\S]{0,400}gas/);
    // And it must say outright that a false zero is the failure mode being
    // guarded against -- not merely omit a number silently.
    expect(doc.toLowerCase()).toMatch(/claims? the write cost nothing|false.{0,20}zero|false.{0,20}"?0"?/);
  });

  it("states in prose that a mined receipt proves landing, not that the stream actually changed", async () => {
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");
    expect(doc.toLowerCase()).toMatch(/mined receipt/);
    expect(doc.toLowerCase()).toMatch(/chain read/);
  });

  it("states which response contract was observed outright, rather than leaving a reader to infer it from a missing field", async () => {
    const doc = await readFile(EVIDENCE_MD_PATH, "utf8");
    expect(doc).toMatch(/response contract/i);
    expect(doc).toContain("outcome.contract");
    // The document must not fall back to the same "absent field means not
    // stated" convention it deliberately uses for `sponsored` -- this row
    // is always filled in with an actual value, never left blank.
    expect(doc.toLowerCase()).not.toMatch(/response contract[^\n]*not stated/);
  });
});
