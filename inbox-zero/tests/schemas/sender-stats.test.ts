import { describe, expect, it } from "vitest";
import { SenderStatsSchema } from "../../src/schemas/sender-stats.ts";
import { SenderTypeEnum } from "../../src/schemas/sender-type.js";

const validSenderStats = {
  senderEmail: "newsletter@example.com",
  senderName: "Example Newsletter",
  emailCount: 42,
  firstEmailDate: "2024-01-15",
  lastEmailDate: "2025-01-10",
  gmailCategory: "promotions",
  unreadRatio: 0.85,
  threadCount: 38,
  sampleSubjects: ["Sale today!", "New arrivals", "Your weekly digest"],
  surprisesFlag: false,
};

describe("SenderStatsSchema", () => {
  describe("valid inputs", () => {
    it("parses valid sender stats with all audit columns", () => {
      const result = SenderStatsSchema.parse(validSenderStats);
      expect(result.senderEmail).toBe("newsletter@example.com");
      expect(result.senderName).toBe("Example Newsletter");
      expect(result.emailCount).toBe(42);
      expect(result.firstEmailDate).toBe("2024-01-15");
      expect(result.lastEmailDate).toBe("2025-01-10");
      expect(result.gmailCategory).toBe("promotions");
      expect(result.unreadRatio).toBe(0.85);
      expect(result.threadCount).toBe(38);
      expect(result.sampleSubjects).toHaveLength(3);
      expect(result.surprisesFlag).toBe(false);
    });

    it("parses with all optional fields present", () => {
      const full = {
        ...validSenderStats,
        confidenceTier: "definitely_noise",
        recommendedAction: "unsubscribe",
        userDecision: "filter",
      };
      const result = SenderStatsSchema.parse(full);
      expect(result.confidenceTier).toBe("definitely_noise");
      expect(result.recommendedAction).toBe("unsubscribe");
      expect(result.userDecision).toBe("filter");
    });

    it("parses when optional fields are absent (omitted)", () => {
      const result = SenderStatsSchema.parse(validSenderStats);
      expect(result.confidenceTier).toBeUndefined();
      expect(result.recommendedAction).toBeUndefined();
      expect(result.userDecision).toBeUndefined();
    });

    it("parses userDecision as null (not yet filled in by user)", () => {
      const withNull = { ...validSenderStats, userDecision: null };
      const result = SenderStatsSchema.parse(withNull);
      expect(result.userDecision).toBeNull();
    });

    it("defaults surprisesFlag to false when not provided", () => {
      const { surprisesFlag: _dropped, ...withoutFlag } = validSenderStats;
      const result = SenderStatsSchema.parse(withoutFlag);
      expect(result.surprisesFlag).toBe(false);
    });

    it("parses sampleSubjects as array of strings", () => {
      const result = SenderStatsSchema.parse(validSenderStats);
      expect(Array.isArray(result.sampleSubjects)).toBe(true);
      for (const s of result.sampleSubjects) {
        expect(typeof s).toBe("string");
      }
    });

    it("parses with empty sampleSubjects array", () => {
      const result = SenderStatsSchema.parse({ ...validSenderStats, sampleSubjects: [] });
      expect(result.sampleSubjects).toHaveLength(0);
    });

    it("accepts all valid confidenceTier values", () => {
      const tiers = ["definitely_noise", "probably_noise", "probably_keep", "definitely_keep"] as const;
      for (const tier of tiers) {
        const result = SenderStatsSchema.parse({ ...validSenderStats, confidenceTier: tier });
        expect(result.confidenceTier).toBe(tier);
      }
    });

    it("accepts all valid recommendedAction values", () => {
      const actions = ["keep", "filter", "unsubscribe"] as const;
      for (const action of actions) {
        const result = SenderStatsSchema.parse({ ...validSenderStats, recommendedAction: action });
        expect(result.recommendedAction).toBe(action);
      }
    });

    it("parses unreadRatio at boundary values 0 and 1", () => {
      const at0 = SenderStatsSchema.parse({ ...validSenderStats, unreadRatio: 0 });
      expect(at0.unreadRatio).toBe(0);

      const at1 = SenderStatsSchema.parse({ ...validSenderStats, unreadRatio: 1 });
      expect(at1.unreadRatio).toBe(1);
    });
  });

  describe("invalid inputs", () => {
    it("rejects invalid confidenceTier value", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, confidenceTier: "maybe_noise" })).toThrow();
    });

    it("rejects invalid recommendedAction value", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, recommendedAction: "delete" })).toThrow();
    });

    it("rejects unreadRatio below 0", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, unreadRatio: -0.1 })).toThrow();
    });

    it("rejects unreadRatio above 1", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, unreadRatio: 1.1 })).toThrow();
    });

    it("rejects sampleSubjects exceeding max 5", () => {
      expect(() =>
        SenderStatsSchema.parse({
          ...validSenderStats,
          sampleSubjects: ["a", "b", "c", "d", "e", "f"],
        }),
      ).toThrow();
    });

    it("rejects missing required senderEmail", () => {
      const { senderEmail: _dropped, ...withoutEmail } = validSenderStats;
      expect(() => SenderStatsSchema.parse(withoutEmail)).toThrow();
    });

    it("rejects non-number emailCount", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, emailCount: "42" })).toThrow();
    });

    it("rejects sampleSubjects with non-string elements", () => {
      expect(() => SenderStatsSchema.parse({ ...validSenderStats, sampleSubjects: [1, 2, 3] })).toThrow();
    });
  });
});

describe("SenderStatsSchema enrichment fields", () => {
  it("backward compatibility — existing stats without new fields still valid", () => {
    const result = SenderStatsSchema.parse(validSenderStats);
    expect(result.senderEmail).toBe("newsletter@example.com");
    expect(result.senderType).toBeUndefined();
    expect(result.senderTypeConfidence).toBeUndefined();
    expect(result.extractionCandidate).toBeUndefined();
    expect(result.starredCount).toBe(0);
    expect(result.importantCount).toBe(0);
  });

  it("accepts senderType and senderTypeConfidence", () => {
    const result = SenderStatsSchema.parse({
      ...validSenderStats,
      senderType: "newsletter",
      senderTypeConfidence: 0.95,
    });
    expect(result.senderType).toBe("newsletter");
    expect(result.senderTypeConfidence).toBe(0.95);
  });

  it("accepts all valid senderType enum values", () => {
    const types = SenderTypeEnum.options;
    for (const t of types) {
      const result = SenderStatsSchema.parse({ ...validSenderStats, senderType: t });
      expect(result.senderType).toBe(t);
    }
  });

  it("accepts extractionCandidate boolean", () => {
    const withTrue = SenderStatsSchema.parse({ ...validSenderStats, extractionCandidate: true });
    expect(withTrue.extractionCandidate).toBe(true);

    const withFalse = SenderStatsSchema.parse({ ...validSenderStats, extractionCandidate: false });
    expect(withFalse.extractionCandidate).toBe(false);
  });

  it("accepts starredCount and importantCount", () => {
    const result = SenderStatsSchema.parse({
      ...validSenderStats,
      starredCount: 5,
      importantCount: 12,
    });
    expect(result.starredCount).toBe(5);
    expect(result.importantCount).toBe(12);
  });

  it("defaults starredCount to 0 when absent", () => {
    const result = SenderStatsSchema.parse(validSenderStats);
    expect(result.starredCount).toBe(0);
  });

  it("defaults importantCount to 0 when absent", () => {
    const result = SenderStatsSchema.parse(validSenderStats);
    expect(result.importantCount).toBe(0);
  });

  it("rejects invalid senderType value", () => {
    expect(() => SenderStatsSchema.parse({ ...validSenderStats, senderType: "robot" })).toThrow();
  });

  it("rejects senderTypeConfidence below 0", () => {
    expect(() => SenderStatsSchema.parse({ ...validSenderStats, senderTypeConfidence: -0.1 })).toThrow();
  });

  it("rejects senderTypeConfidence above 1", () => {
    expect(() => SenderStatsSchema.parse({ ...validSenderStats, senderTypeConfidence: 1.1 })).toThrow();
  });

  it("accepts senderTypeConfidence at boundary values 0 and 1", () => {
    const at0 = SenderStatsSchema.parse({ ...validSenderStats, senderTypeConfidence: 0 });
    expect(at0.senderTypeConfidence).toBe(0);

    const at1 = SenderStatsSchema.parse({ ...validSenderStats, senderTypeConfidence: 1 });
    expect(at1.senderTypeConfidence).toBe(1);
  });
});
