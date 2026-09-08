import { defineConfig } from "vitest/config";

/**
 * Runs only tests/docs/evidence.test.ts -- the gate that checks
 * docs/EVIDENCE.md against docs/evidence/run.json. Deliberately separate
 * from vitest.config.ts (which excludes this file): the gate is red on
 * every run until the live Sepolia demonstration happens and is captured,
 * and that must not make `pnpm test` red too. Run with `pnpm test:evidence`.
 */
export default defineConfig({
  test: { include: ["tests/docs/evidence.test.ts"] },
});
