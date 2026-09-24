import { describe, expect, it } from "vitest";
import { resolveVersion } from "../../src/runner/version.js";

describe("resolveVersion", () => {
  it("prefers an explicit RUNWAY_VERSION, which is what a deployment sets", () => {
    const version = resolveVersion({ RUNWAY_VERSION: "44ba611" }, () => "should not be called");
    expect(version).toBe("44ba611");
  });

  /** A clean tree: `git status --porcelain` prints nothing. */
  const cleanTree = (command: string) => (command.includes("status") ? "" : "cb01834\n");

  it("falls back to the commit the working tree is on", () => {
    expect(resolveVersion({}, cleanTree)).toBe("cb01834");
  });

  it("marks a dirty working tree, because that commit is not what ran", () => {
    const version = resolveVersion({}, (command) =>
      command.includes("status") ? " M src/cli.ts\n" : "cb01834\n",
    );
    expect(version).toBe("cb01834-dirty");
  });

  it("says unknown rather than guessing when git cannot answer", () => {
    expect(
      resolveVersion({}, () => {
        throw new Error("not a git repository");
      }),
    ).toBe("unknown");
  });

  it("ignores an empty RUNWAY_VERSION rather than recording a blank version", () => {
    expect(resolveVersion({ RUNWAY_VERSION: "" }, cleanTree)).toBe("cb01834");
  });
});
