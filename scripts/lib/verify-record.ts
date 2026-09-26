import path from "node:path";
import type { Policy } from "../../src/policy/types.js";
import { fromSerialisable } from "../../src/runner/record.js";
import { type RecordVerdict, verifyRecord } from "../../src/runner/verify.js";

export type RunsOutcome = {
  verdicts: RecordVerdict[];
  summary: string;
  ok: boolean;
};

export type RunsDirectory = {
  policy: Policy;
  dir: string;
  /**
   * Whether the caller named this directory, rather than falling back to the
   * default. It decides what an empty directory means, and that is the whole
   * reason this flag exists — see below.
   */
  explicit: boolean;
  list: (dir: string) => string[];
  read: (file: string) => string;
};

/**
 * Re-decides every record in a directory and reports what held.
 *
 * The interesting case is the empty one. `runs/` is gitignored, so on a fresh
 * checkout there is nothing to verify — for an operator who has just cloned
 * the repository that is normal, and failing there would teach them to ignore
 * the one gate that matters. But CI ran exactly that command on exactly that
 * checkout: it found no directory, printed "nothing to verify" and went
 * green, every time, for every change. A gate that cannot fail is not a gate.
 *
 * So the two cases are separated by who chose the directory. The default,
 * missing, is nothing to verify. A directory named on the command line —
 * which is what CI now does, against the committed record in `docs/evidence`
 * — must exist and must hold at least one record, or the run fails.
 */
export function verifyRunsDirectory({ policy, dir, explicit, list, read }: RunsDirectory): RunsOutcome {
  let entries: string[];
  try {
    entries = list(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return explicit
      ? { verdicts: [], ok: false, summary: `no directory at ${dir}, and it was asked for by name` }
      : { verdicts: [], ok: true, summary: `no runs directory at ${dir}; nothing to verify` };
  }

  if (entries.length === 0 && explicit) {
    return { verdicts: [], ok: false, summary: `${dir} holds no records, and it was asked for by name` };
  }

  const verdicts = entries
    .sort()
    .map((entry) =>
      verifyRecord(fromSerialisable(JSON.parse(read(path.posix.join(dir, entry)))), policy),
    );

  const failed = verdicts.filter((verdict) => !verdict.ok).length;
  return {
    verdicts,
    ok: failed === 0,
    summary: `${verdicts.length - failed}/${verdicts.length} records verified`,
  };
}
