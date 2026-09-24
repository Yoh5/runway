/** Runs a shell command and returns stdout. Injected so this is testable. */
export type ExecFn = (command: string) => string;

/**
 * Which code produced a run.
 *
 * A record that says what was decided, under which policy, but not by which
 * version of the agent, leaves one question open that nobody can answer
 * afterwards: was this the code we think it was? `RUNWAY_VERSION` is what a
 * deployment sets (a build stamps it); the git commit is the answer for a
 * local run; and a dirty working tree is marked as such, because that commit
 * is precisely not what ran.
 *
 * "unknown" rather than a guess when git cannot answer: a version nobody can
 * check is worse than an admitted gap.
 */
export function resolveVersion(
  env: Record<string, string | undefined>,
  exec: ExecFn,
): string {
  const declared = env.RUNWAY_VERSION?.trim();
  if (declared) return declared;

  try {
    const commit = exec("git rev-parse --short HEAD").trim();
    if (!commit) return "unknown";
    const dirty = exec("git status --porcelain").trim().length > 0;
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "unknown";
  }
}
