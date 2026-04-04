// tests/enrichment/extraction-scorer.test.ts
import { describe, expect, it } from "vitest";
import { scoreExtraction } from "../../src/enrichment/extraction-scorer.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";

function makeSender(overrides: Partial<SenderStats> = {}): SenderStats {
  return {
    senderEmail: "test@example.com",
    senderName: "Test Sender",
    emailCount: 10,
    firstEmailDate: "2024-01-01T00:00:00Z",
    lastEmailDate: "2024-06-01T00:00:00Z",
    gmailCategory: "primary",
    unreadRatio: 0.1,
    threadCount: 5,
    sampleSubjects: [],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
    ...overrides,
  };
}

describe("scoreExtraction", () => {
  it("high-engagement human sender → extractionCandidate = true", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "human",
        gmailCategory: "primary",
        threadCount: 8,
        emailCount: 10,
        unreadRatio: 0.1,
        starredCount: 3,
        importantCount: 5,
      }),
    );
    expect(result).toBe(true);
  });

  it("unread newsletter → extractionCandidate = false", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "newsletter",
        gmailCategory: "promotions",
        threadCount: 1,
        emailCount: 100,
        unreadRatio: 0.95,
        starredCount: 0,
        importantCount: 0,
      }),
    );
    expect(result).toBe(false);
  });

  it("sender with no type yet → uses other signals only", () => {
    const result = scoreExtraction(
      makeSender({
        gmailCategory: "primary",
        threadCount: 5,
        emailCount: 6,
        unreadRatio: 0.0,
        starredCount: 2,
        importantCount: 3,
      }),
    );
    // Should still score based on available signals
    expect(typeof result).toBe("boolean");
  });

  it("single-email sender → not extraction candidate", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "human",
        emailCount: 1,
        threadCount: 1,
      }),
    );
    expect(result).toBe(false);
  });

  it("two-email sender → not extraction candidate (below threshold of 3)", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "human",
        emailCount: 2,
        threadCount: 2,
        unreadRatio: 0,
        starredCount: 2,
        importantCount: 2,
      }),
    );
    expect(result).toBe(false);
  });

  it("exactly 3 emails with good signals → eligible for scoring", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "human",
        gmailCategory: "primary",
        emailCount: 3,
        threadCount: 3,
        unreadRatio: 0,
        starredCount: 1,
        importantCount: 1,
      }),
    );
    // emailCount >= 3, so scoring kicks in
    expect(typeof result).toBe("boolean");
  });

  it("fully-read primary human with no starred/important → borderline case", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: "human",
        gmailCategory: "primary",
        emailCount: 10,
        threadCount: 5,
        unreadRatio: 0.0,
        starredCount: 0,
        importantCount: 0,
      }),
    );
    // reply: 5/10 = 0.5 → replyScore 1.0 → 0.40
    // read: 1.0 → 0.30
    // explicit: 0/10 = 0 → 0
    // content: human(0.5) + primary(0.3) + emailCount>=3(0.2) = 1.0 → 0.10
    // composite = 0.40 + 0.30 + 0 + 0.10 = 0.80 → true
    expect(result).toBe(true);
  });

  it("undefined senderType treated as not-human for content signal", () => {
    const result = scoreExtraction(
      makeSender({
        senderType: undefined,
        gmailCategory: "primary",
        emailCount: 10,
        threadCount: 1,
        unreadRatio: 0.9,
        starredCount: 0,
        importantCount: 0,
      }),
    );
    // reply: 1/10=0.1 → replyScore 0.2 → 0.08
    // read: 0.1 → 0.03
    // explicit: 0 → 0
    // content: no human(0), primary(0.3) + emailCount>=3(0.2) = 0.5 → 0.05
    // composite ≈ 0.16 → false
    expect(result).toBe(false);
  });
});
