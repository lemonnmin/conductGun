import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "../src/index";

describe("scaffold smoke", () => {
  it("core module loads via ESM", () => {
    expect(CORE_PACKAGE).toBe("@conductgun/core");
  });
});