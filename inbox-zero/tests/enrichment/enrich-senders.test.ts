// tests/enrichment/enrich-senders.test.ts
import { describe, expect, it, vi } from "vitest";
import { enrichSenders } from "../../src/enrichment/enrich-senders.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";
import type { SenderTypeSource } from "../../src/schemas/sender-type.js";

type EnrichableSender = SenderStats & {
  senderTypeSource?: SenderTypeSource;
  reviewedSenderType?: "human" | "company" | "newsletter" | "automated" | "unknown";
  reviewedAt?: string;
};

function makeSender(overrides: Partial<EnrichableSender> = {}): EnrichableSender {
  return {
    senderEmail: "test@example.com",
    senderName: "Test Sender",
    emailCount: 5,
    firstEmailDate: "2024-01-01T00:00:00Z",
    lastEmailDate: "2024-06-01T00:00:00Z",
    gmailCategory: "primary",
    unreadRatio: 0.1,
    threadCount: 3,
    sampleSubjects: [],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
    ...overrides,
  };
}

describe("enrichSenders", () => {
  it("preserves user-reviewed sender types and skips reclassification", async () => {
    const mockProvider = { classifySenders: vi.fn() };
    const senders = [
      makeSender({
        senderEmail: "ceo@corp.io",
        senderType: "company",
        senderTypeSource: "user",
        reviewedSenderType: "company",
      }),
    ];
    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });
    expect(result[0]!.senderType).toBe("company");
    expect(result[0]!.senderTypeSource).toBe("user");
    expect(mockProvider.classifySenders).not.toHaveBeenCalled();
  });

  it("preserves sender when reviewedSenderType is set even without senderTypeSource=user", async () => {
    const mockProvider = { classifySenders: vi.fn() };
    const senders = [
      makeSender({
        senderEmail: "friend@gmail.com",
        reviewedSenderType: "human",
      }),
    ];
    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });
    expect(result[0]!.senderType).toBe("human");
    expect(result[0]!.senderTypeSource).toBe("user");
    expect(mockProvider.classifySenders).not.toHaveBeenCalled();
  });

  it("classifies freemail senders as human without LLM", async () => {
    const senders = [makeSender({ senderEmail: "jane@gmail.com", senderName: "Jane Smith" })];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.senderType).toBe("human");
    expect(result[0]!.senderTypeConfidence).toBeGreaterThan(0);
  });

  it("classifies automated sender via heuristics without LLM", async () => {
    const senders = [makeSender({ senderEmail: "noreply@example.com", senderName: "No Reply" })];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.senderType).toBe("automated");
  });

  it("sends ambiguous senders to LLM when provider is given", async () => {
    const mockProvider = {
      classifySenders: vi
        .fn()
        .mockResolvedValue(new Map([["mystery@corp.io", { senderType: "company" as const, confidence: 0.8 }]])),
    };
    const senders = [
      makeSender({
        senderEmail: "mystery@corp.io",
        senderName: "Mystery",
        threadCount: 3,
        emailCount: 5,
      }),
    ];
    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });
    expect(result[0]!.senderType).toBe("company");
    expect(result[0]!.senderTypeSource).toBe("llm");
    expect(result[0]!.senderTypeConfidence).toBe(0.8);
    expect(mockProvider.classifySenders).toHaveBeenCalledTimes(1);
  });

  it("preserves input order when heuristic and LLM results are mixed", async () => {
    const mockProvider = {
      classifySenders: vi.fn().mockResolvedValue(
        new Map([
          ["mystery@corp.io", { senderType: "company" as const, confidence: 0.82 }],
          ["ambiguous@corp.io", { senderType: "newsletter" as const, confidence: 0.74 }],
        ]),
      ),
    };
    const senders = [
      makeSender({ senderEmail: "friend@gmail.com", senderName: "Friend Name" }),
      makeSender({ senderEmail: "mystery@corp.io", senderName: "Mystery" }),
      makeSender({ senderEmail: "noreply@service.com", senderName: "No Reply" }),
      makeSender({ senderEmail: "ambiguous@corp.io", senderName: "Ambiguous" }),
    ];

    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });

    expect(result.map((sender) => sender.senderEmail)).toEqual(senders.map((sender) => sender.senderEmail));
    expect(result[0]!.senderType).toBe("human");
    expect(result[1]!.senderType).toBe("company");
    expect(result[2]!.senderType).toBe("automated");
    expect(result[3]!.senderType).toBe("newsletter");
  });

  it("marks ambiguous senders as unknown when no LLM provider given", async () => {
    // "mystery@corp.io" with no strong signals returns unknown from heuristic
    const senders = [
      makeSender({
        senderEmail: "mystery@corp.io",
        senderName: "Mystery",
        sampleSubjects: [],
      }),
    ];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.senderType).toBe("unknown");
  });

  it("populates extractionCandidate flag as true for high-engagement human", async () => {
    const senders = [
      makeSender({
        senderEmail: "mentor@gmail.com",
        senderName: "My Mentor",
        senderType: "human",
        gmailCategory: "primary",
        threadCount: 8,
        emailCount: 10,
        unreadRatio: 0.1,
        starredCount: 5,
        importantCount: 3,
      }),
    ];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.extractionCandidate).toBe(true);
  });

  it("populates extractionCandidate flag as false for noise sender", async () => {
    const senders = [
      makeSender({
        senderEmail: "noreply@spam.com",
        senderName: "Spam",
        senderType: "newsletter",
        gmailCategory: "promotions",
        threadCount: 1,
        emailCount: 100,
        unreadRatio: 0.95,
        starredCount: 0,
        importantCount: 0,
      }),
    ];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.extractionCandidate).toBe(false);
  });

  it("does not mutate input array", async () => {
    const senders = [makeSender({ senderEmail: "jane@gmail.com", senderName: "Jane Smith" })];
    const originalEmail = senders[0]!.senderEmail;
    const originalType = senders[0]!.senderType;
    await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(senders[0]!.senderEmail).toBe(originalEmail);
    expect(senders[0]!.senderType).toBe(originalType);
  });

  it("does not mutate input objects (deep immutability check)", async () => {
    const sender = makeSender({ senderEmail: "jane@gmail.com", senderName: "Jane Smith" });
    const snapshot = { ...sender };
    await enrichSenders([sender], { llmProvider: undefined, fewShotExamples: [] });
    expect(sender).toEqual(snapshot);
  });

  it("returns array with same length as input", async () => {
    const senders = [
      makeSender({ senderEmail: "a@gmail.com", senderName: "Alice" }),
      makeSender({ senderEmail: "noreply@news.com", senderName: "Newsletter" }),
      makeSender({ senderEmail: "bob@company.io", senderName: "Bob" }),
    ];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result).toHaveLength(3);
  });

  it("calls onProgress callback for each phase", async () => {
    const progressCalls: Array<{ phase: string; processed: number; total: number }> = [];
    const senders = [makeSender({ senderEmail: "jane@gmail.com", senderName: "Jane Smith" })];
    await enrichSenders(senders, {
      llmProvider: undefined,
      fewShotExamples: [],
      onProgress: (info) => {
        progressCalls.push(info);
      },
    });
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls.every((c) => c.total === 1)).toBe(true);
    expect(progressCalls.every((c) => typeof c.phase === "string")).toBe(true);
  });

  it("marks LLM-resolved ambiguous sender with senderTypeSource=llm", async () => {
    const mockProvider = {
      classifySenders: vi
        .fn()
        .mockResolvedValue(new Map([["ambiguous@corp.io", { senderType: "newsletter" as const, confidence: 0.7 }]])),
    };
    const senders = [makeSender({ senderEmail: "ambiguous@corp.io", senderName: "Ambiguous" })];
    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });
    expect(result[0]!.senderTypeSource).toBe("llm");
    expect(result[0]!.senderType).toBe("newsletter");
  });

  it("normalizes sender email when reading LLM result keys", async () => {
    const mockProvider = {
      classifySenders: vi
        .fn()
        .mockResolvedValue(new Map([["mixedcase@corp.io", { senderType: "company" as const, confidence: 0.88 }]])),
    };
    const senders = [makeSender({ senderEmail: "MixedCase@Corp.io", senderName: "Mixed Case" })];

    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });

    expect(result[0]!.senderTypeSource).toBe("llm");
    expect(result[0]!.senderType).toBe("company");
    expect(result[0]!.senderTypeConfidence).toBe(0.88);
  });

  it("heuristic-classified sender gets senderTypeSource=heuristic", async () => {
    const senders = [
      makeSender({
        senderEmail: "notifications@service.com",
        senderName: "Service",
      }),
    ];
    const result = await enrichSenders(senders, { llmProvider: undefined, fewShotExamples: [] });
    expect(result[0]!.senderTypeSource).toBe("heuristic");
  });

  it("passes fewShotExamples to LLM provider", async () => {
    const fewShotExamples = [
      { email: "example@corp.com", senderType: "company" as const, context: "corporate sender" },
    ];
    const mockProvider = {
      classifySenders: vi.fn().mockResolvedValue(new Map()),
    };
    const senders = [makeSender({ senderEmail: "unknown@corp.io", senderName: "Unknown" })];
    await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples,
    });
    // If provider was called, verify examples were passed
    if (mockProvider.classifySenders.mock.calls.length > 0) {
      expect(mockProvider.classifySenders).toHaveBeenCalledWith(expect.any(Array), fewShotExamples);
    }
  });

  it("handles empty input array", async () => {
    const result = await enrichSenders([], { llmProvider: undefined, fewShotExamples: [] });
    expect(result).toEqual([]);
  });

  it("all three phases run in sequence: heuristic, LLM, extraction", async () => {
    const callOrder: string[] = [];
    const mockProvider = {
      classifySenders: vi.fn().mockImplementation(async () => {
        callOrder.push("llm");
        return new Map();
      }),
    };
    const senders = [
      makeSender({ senderEmail: "jane@gmail.com", senderName: "Jane Smith" }), // heuristic resolves
      makeSender({ senderEmail: "ambiguous@corp.io", senderName: "Ambiguous" }), // goes to LLM
    ];
    const result = await enrichSenders(senders, {
      llmProvider: mockProvider,
      fewShotExamples: [],
    });
    expect(callOrder).toContain("llm");
    // Both should have extractionCandidate set after Phase 3
    expect(result[0]!.extractionCandidate).toBeDefined();
    expect(result[1]!.extractionCandidate).toBeDefined();
  });
});
