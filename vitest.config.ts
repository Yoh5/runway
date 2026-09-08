import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/docs/evidence.test.ts is a gate against the one live Sepolia
    // demonstration run's captured evidence (docs/evidence/run.json). It is
    // deliberately red until that run happens and is captured -- see
    // vitest.evidence.config.ts and the `test:evidence` script, which run it
    // on its own. A permanently red test inside the main suite trains
    // people to ignore red, so it is excluded here rather than shipped
    // failing alongside the rest.
    exclude: ["tests/docs/evidence.test.ts"],
  },
});
