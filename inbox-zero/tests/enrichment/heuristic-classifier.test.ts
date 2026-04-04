// tests/enrichment/heuristic-classifier.test.ts
import { describe, expect, it } from "vitest";
import { classifyHeuristic } from "../../src/enrichment/heuristic-classifier.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";

function makeSender(overrides: Partial<SenderStats> = {}): SenderStats {
  return {
    senderEmail: "test@example.com",
    senderName: "Test User",
    emailCount: 10,
    firstEmailDate: "2025-01-01T00:00:00Z",
    lastEmailDate: "2026-03-01T00:00:00Z",
    gmailCategory: "primary",
    unreadRatio: 0.2,
    threadCount: 8,
    sampleSubjects: ["Hello", "Re: Meeting"],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
    ...overrides,
  };
}

describe("classifyHeuristic", () => {
  describe("hard overrides — automated local parts", () => {
    for (const local of ["noreply", "no-reply", "notifications", "mailer", "digest"]) {
      it(`${local}@domain → automated (hard override)`, () => {
        const result = classifyHeuristic(makeSender({ senderEmail: `${local}@company.com` }));
        expect(result.senderType).toBe("automated");
      });
    }

    it("noreply@gmail.com → automated (not human despite freemail domain)", () => {
      const result = classifyHeuristic(makeSender({ senderEmail: "noreply@gmail.com" }));
      expect(result.senderType).toBe("automated");
    });
  });

  describe("freemail domains → human", () => {
    for (const domain of ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"]) {
      it(`user@${domain} → human`, () => {
        const result = classifyHeuristic(
          makeSender({
            senderEmail: `jane@${domain}`,
            senderName: "Jane Smith",
            threadCount: 8,
            emailCount: 10,
          }),
        );
        expect(result.senderType).toBe("human");
      });
    }
  });

  describe("display name patterns", () => {
    it("'Firstname Lastname' pattern → human signal", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "jane@acme.com",
          senderName: "Jane Smith",
          threadCount: 8,
          sampleSubjects: ["Re: Q4 planning", "Meeting notes"],
        }),
      );
      expect(result.senderType).toBe("human");
    });

    it("name with 'Newsletter' → newsletter signal", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "hello@techco.com",
          senderName: "TechCo Newsletter",
          threadCount: 1,
          emailCount: 50,
          unreadRatio: 0.9,
        }),
      );
      expect(result.senderType).toBe("newsletter");
    });
  });

  describe("thread ratio", () => {
    it("high thread ratio (≥0.7) → human signal", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "bob@acme.com",
          senderName: "Bob Jones",
          threadCount: 9,
          emailCount: 10,
          sampleSubjects: ["Re: Project update"],
        }),
      );
      expect(result.senderType).toBe("human");
    });

    it("low thread ratio (≤0.1) → newsletter/automated signal", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "updates@service.com",
          senderName: "Service Updates",
          threadCount: 2,
          emailCount: 100,
          sampleSubjects: ["Your weekly digest", "Your monthly report"],
        }),
      );
      expect(["newsletter", "automated"]).toContain(result.senderType);
    });
  });

  describe("subject pattern detection", () => {
    it("template subjects → automated", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "orders@shop.com",
          senderName: "Shop",
          threadCount: 1,
          emailCount: 20,
          sampleSubjects: ["Your order #12345", "Your receipt", "Shipping update for order #12346"],
        }),
      );
      expect(["automated", "newsletter"]).toContain(result.senderType);
    });

    it("digest-style newsletters contribute to newsletter scoring", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "hello@product.com",
          senderName: "Product Weekly Digest",
          threadCount: 1,
          emailCount: 40,
          unreadRatio: 0.85,
          sampleSubjects: ["Weekly digest", "Monthly roundup", "Daily updates"],
        }),
      );

      expect(result.senderType).toBe("newsletter");
    });
  });

  describe("ambiguous senders → unknown", () => {
    it("returns unknown when no signal reaches threshold", () => {
      const result = classifyHeuristic(
        makeSender({
          senderEmail: "contact@ambiguous.io",
          senderName: "Ambiguous",
          threadCount: 3,
          emailCount: 5,
          sampleSubjects: ["Info"],
        }),
      );
      expect(result.senderType).toBe("unknown");
    });
  });

  it("returns confidence score between 0 and 1", () => {
    const result = classifyHeuristic(makeSender({ senderEmail: "jane@gmail.com" }));
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
