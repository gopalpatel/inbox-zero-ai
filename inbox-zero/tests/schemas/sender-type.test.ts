import { describe, expect, it } from "vitest";
import { SenderTypeEnum } from "../../src/schemas/sender-type.js";

describe("SenderTypeEnum", () => {
  it("accepts valid sender types", () => {
    for (const t of ["human", "company", "newsletter", "automated", "unknown"]) {
      expect(SenderTypeEnum.safeParse(t).success).toBe(true);
    }
  });

  it("rejects invalid sender types", () => {
    expect(SenderTypeEnum.safeParse("robot").success).toBe(false);
    expect(SenderTypeEnum.safeParse("").success).toBe(false);
    expect(SenderTypeEnum.safeParse(42).success).toBe(false);
  });
});
