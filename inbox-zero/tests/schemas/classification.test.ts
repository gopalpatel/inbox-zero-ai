import { describe, expect, it } from "vitest";
import { ThreadClassificationSchema } from "../../src/schemas/classification.ts";

const validClassification = {
  threadId: "thread_abc123",
  category: "newsletter",
  confidence: 0.92,
  actionable: false,
  summary: "Weekly digest from Example Co with product updates and promotions.",
  classifiedBy: "llm",
};

describe("ThreadClassificationSchema", () => {
  describe("valid inputs", () => {
    it("parses valid classification with category, confidence, actionable, summary, and threadId", () => {
      const result = ThreadClassificationSchema.parse(validClassification);
      expect(result.threadId).toBe("thread_abc123");
      expect(result.category).toBe("newsletter");
      expect(result.confidence).toBe(0.92);
      expect(result.actionable).toBe(false);
      expect(result.summary).toBe("Weekly digest from Example Co with product updates and promotions.");
      expect(result.classifiedBy).toBe("llm");
    });

    it("parses classification classified by rule engine with ruleName", () => {
      const ruleClassified = {
        ...validClassification,
        classifiedBy: "rule",
        ruleName: "no-reply-sender",
      };
      const result = ThreadClassificationSchema.parse(ruleClassified);
      expect(result.classifiedBy).toBe("rule");
      expect(result.ruleName).toBe("no-reply-sender");
    });

    it("parses classification classified by llm without ruleName", () => {
      const result = ThreadClassificationSchema.parse(validClassification);
      expect(result.classifiedBy).toBe("llm");
      expect(result.ruleName).toBeUndefined();
    });

    it("accepts actionable as true", () => {
      const result = ThreadClassificationSchema.parse({ ...validClassification, actionable: true });
      expect(result.actionable).toBe(true);
    });

    it("accepts any non-empty string for category (data-driven, not enum)", () => {
      const categories = ["newsletter", "transactional", "personal", "work", "promotional", "github-notification"];
      for (const category of categories) {
        const result = ThreadClassificationSchema.parse({ ...validClassification, category });
        expect(result.category).toBe(category);
      }
    });

    it("parses confidence at boundary value 0", () => {
      const result = ThreadClassificationSchema.parse({ ...validClassification, confidence: 0 });
      expect(result.confidence).toBe(0);
    });

    it("parses confidence at boundary value 1", () => {
      const result = ThreadClassificationSchema.parse({ ...validClassification, confidence: 1 });
      expect(result.confidence).toBe(1);
    });

    it("accepts summary up to 500 characters", () => {
      const longSummary = "A".repeat(500);
      const result = ThreadClassificationSchema.parse({ ...validClassification, summary: longSummary });
      expect(result.summary).toHaveLength(500);
    });
  });

  describe("invalid inputs", () => {
    it("rejects missing threadId", () => {
      const { threadId: _dropped, ...withoutThreadId } = validClassification;
      expect(() => ThreadClassificationSchema.parse(withoutThreadId)).toThrow();
    });

    it("rejects empty string threadId", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, threadId: "" })).toThrow();
    });

    it("rejects empty string category", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, category: "" })).toThrow();
    });

    it("rejects missing category", () => {
      const { category: _dropped, ...withoutCategory } = validClassification;
      expect(() => ThreadClassificationSchema.parse(withoutCategory)).toThrow();
    });

    it("rejects confidence below 0", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, confidence: -0.1 })).toThrow();
    });

    it("rejects confidence above 1", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, confidence: 1.1 })).toThrow();
    });

    it("rejects non-boolean actionable", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, actionable: "yes" })).toThrow();
    });

    it("rejects invalid classifiedBy value", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, classifiedBy: "human" })).toThrow();
    });

    it("rejects summary exceeding 500 characters", () => {
      expect(() => ThreadClassificationSchema.parse({ ...validClassification, summary: "A".repeat(501) })).toThrow();
    });

    it("rejects missing summary", () => {
      const { summary: _dropped, ...withoutSummary } = validClassification;
      expect(() => ThreadClassificationSchema.parse(withoutSummary)).toThrow();
    });
  });
});
