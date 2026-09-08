import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderReport } from "../src/report/render.js";
import { EvidenceCaptureError, parseEvidenceBundle } from "./lib/capture-evidence.js";

/**
 * Curates the one demonstration run record into git-tracked evidence.
 * `runs/` is gitignored -- routine run records are logs -- but the run that
 * produced the submission's transaction is evidence, and belongs in the
 * repository a judge can open.
 *
 * Takes the path to a run record on disk (normally one of `runs/*.json`,
 * with one extra top-level `evidence` field added by hand after Task 10's
 * independent chain-read verification step -- see scripts/lib/capture-
 * evidence.ts for that field's shape), and produces:
 *
 *   docs/evidence/run.json    -- the run record, copied verbatim
 *   docs/evidence/report.html -- the same HTML `--report` renders, for just
 *                                 this one run, via the exact same
 *                                 `renderReport` function `src/cli.ts` calls
 *                                 -- nothing here re-implements that markup.
 *
 * This script never touches the chain and never calls KeeperHub's execute
 * API: it only reads a file already on disk and writes two files back.
 */
async function main(): Promise<void> {
  const srcPath = process.argv[2];
  if (!srcPath) {
    throw new Error("usage: capture-evidence.ts <run-record-path>");
  }

  const rawText = await readFile(srcPath, "utf8");
  const bundle = parseEvidenceBundle(rawText);

  const outDir = path.resolve("docs", "evidence");
  await mkdir(outDir, { recursive: true });

  const runJsonPath = path.join(outDir, "run.json");
  await writeFile(runJsonPath, `${JSON.stringify(bundle.raw, null, 2)}\n`);

  const reportPath = path.join(outDir, "report.html");
  await writeFile(reportPath, renderReport([bundle.record]));

  console.log(runJsonPath);
  console.log(reportPath);
}

main().catch((error: unknown) => {
  if (error instanceof EvidenceCaptureError) {
    console.error(`capture-evidence: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
