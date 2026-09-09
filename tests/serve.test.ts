import { describe, expect, it } from "vitest";
import { toTriggerRequest } from "../src/serve.js";

/**
 * Only the request-shaping is tested here; every decision the endpoint makes
 * lives in `trigger/handle.ts` and is tested there. What is left is exactly
 * the part where a wrong reading of a raw request would quietly weaken the
 * handler's refusals: a query string that changes which path was asked for,
 * or a header the caller sent twice.
 */
describe("toTriggerRequest", () => {
  it("reads the path without its query string, so /tick?anything is still /tick", () => {
    const request = toTriggerRequest("POST", "/tick?force=1", {});
    expect(request.path).toBe("/tick");
    expect(request.method).toBe("POST");
  });

  it("does not let a query string invent a path that the handler would reject", () => {
    // "/health?x=/tick" must read as /health, not as anything else.
    expect(toTriggerRequest("GET", "/health?x=/tick", {}).path).toBe("/health");
  });

  it("carries the token through from its header", () => {
    const request = toTriggerRequest("POST", "/tick", { "x-runway-token": "abc" });
    expect(request.token).toBe("abc");
  });

  it("treats a header sent twice as no token at all", () => {
    // Node hands duplicated headers back as an array. Picking one would make
    // this project's authentication depend on which proxy is in front of it.
    const request = toTriggerRequest("POST", "/tick", { "x-runway-token": ["wrong", "right"] });
    expect(request.token).toBeUndefined();
  });

  it("survives a request with no method and no url rather than throwing", () => {
    const request = toTriggerRequest(undefined, undefined, {});
    expect(request).toEqual({ method: "", path: "/", token: undefined });
  });

  it("does not read the token from any other header", () => {
    const request = toTriggerRequest("POST", "/tick", {
      authorization: "Bearer abc",
      "x-api-key": "abc",
    });
    expect(request.token).toBeUndefined();
  });
});

describe("module import safety", () => {
  it("importing src/serve.ts does not start a server", () => {
    // This file imports src/serve.ts at the top, which is precisely the case
    // the entrypoint guard defends. Without it, `main()` would run on import:
    // with RUNWAY_TRIGGER_TOKEN unset (as here) it throws and its `.catch`
    // sets process.exitCode = 1 -- observable proof the import alone ran it.
    // With that variable set, the same unconditional call would instead open
    // a port that can broadcast transactions, inside a test run.
    expect(process.exitCode).not.toBe(1);
  });
});
