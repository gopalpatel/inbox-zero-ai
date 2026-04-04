// tests/enrichment/llm-sender-classifier.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  buildClassificationPrompt,
  classifySendersWithLlm,
  parseClassificationResponse,
} from "../../src/enrichment/llm-sender-classifier.js";
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

describe("buildClassificationPrompt", () => {
  it("includes sender metadata in user message", () => {
    const senders = [makeSender({ senderEmail: "hello@acme.com", senderName: "Acme" })];
    const prompt = buildClassificationPrompt(senders, []);
    expect(prompt.userMessage).toContain("hello@acme.com");
    expect(prompt.userMessage).toContain("Acme");
  });

  it("includes few-shot examples when provided", () => {
    const examples = [{ email: "news@co.com", senderType: "newsletter" as const, context: "..." }];
    const prompt = buildClassificationPrompt([makeSender()], examples);
    expect(prompt.systemMessage).toContain("news@co.com");
    expect(prompt.systemMessage).toContain("newsletter");
  });

  it("batches at most 50 senders per prompt", () => {
    const senders = Array.from({ length: 60 }, (_, i) => makeSender({ senderEmail: `s${i}@test.com` }));
    const prompt = buildClassificationPrompt(senders.slice(0, 50), []);
    const parsed = JSON.parse(prompt.userMessage.slice(prompt.userMessage.indexOf("[")));
    expect(parsed).toHaveLength(50);
  });

  it("returns both systemMessage and userMessage", () => {
    const prompt = buildClassificationPrompt([makeSender()], []);
    expect(typeof prompt.systemMessage).toBe("string");
    expect(typeof prompt.userMessage).toBe("string");
    expect(prompt.systemMessage.length).toBeGreaterThan(0);
    expect(prompt.userMessage.length).toBeGreaterThan(0);
  });

  it("includes valid sender types in system message instructions", () => {
    const prompt = buildClassificationPrompt([makeSender()], []);
    expect(prompt.systemMessage).toContain("human");
    expect(prompt.systemMessage).toContain("newsletter");
    expect(prompt.systemMessage).toContain("automated");
  });

  it("caps sample subjects to 5 per sender", () => {
    const sender = makeSender({
      senderEmail: "many@subjects.com",
      sampleSubjects: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
    });
    const prompt = buildClassificationPrompt([sender], []);
    const jsonStart = prompt.userMessage.indexOf("[");
    const parsed = JSON.parse(prompt.userMessage.slice(jsonStart)) as Array<{ subjects: string[] }>;
    expect(parsed[0]!.subjects.length).toBeLessThanOrEqual(5);
  });
});

describe("parseClassificationResponse", () => {
  it("parses valid JSON array response", () => {
    const json = JSON.stringify([
      { email: "a@test.com", senderType: "human", confidence: 0.9 },
      { email: "b@test.com", senderType: "newsletter", confidence: 0.85 },
    ]);
    const results = parseClassificationResponse(json);
    expect(results).toHaveLength(2);
    expect(results[0]!.senderType).toBe("human");
  });

  it("skips malformed entries without failing", () => {
    const json = JSON.stringify([
      { email: "a@test.com", senderType: "human", confidence: 0.9 },
      { email: "b@test.com", senderType: "invalid_type" },
      { email: "c@test.com" },
    ]);
    const results = parseClassificationResponse(json);
    expect(results).toHaveLength(1);
  });

  it("returns empty array on unparseable response", () => {
    const results = parseClassificationResponse("not json at all");
    expect(results).toHaveLength(0);
  });

  it("extracts JSON array when surrounded by text", () => {
    const text = `Here are the results:\n${JSON.stringify([
      { email: "x@test.com", senderType: "company", confidence: 0.8 },
    ])}\nDone.`;
    const results = parseClassificationResponse(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.senderType).toBe("company");
  });

  it("skips earlier bracketed text and parses the later JSON array", () => {
    const text = `analysis [not json]\nresults ${JSON.stringify([
      { email: "later@test.com", senderType: "newsletter", confidence: 0.81 },
    ])}`;
    const results = parseClassificationResponse(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.email).toBe("later@test.com");
    expect(results[0]!.senderType).toBe("newsletter");
  });

  it("returns empty array for empty JSON array", () => {
    const results = parseClassificationResponse("[]");
    expect(results).toHaveLength(0);
  });

  it("skips entries with confidence out of range", () => {
    const json = JSON.stringify([
      { email: "a@test.com", senderType: "human", confidence: 1.5 },
      { email: "b@test.com", senderType: "newsletter", confidence: 0.7 },
    ]);
    const results = parseClassificationResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.senderType).toBe("newsletter");
  });

  it("returns correct email, senderType, and confidence fields", () => {
    const json = JSON.stringify([{ email: "precise@test.com", senderType: "automated", confidence: 0.95 }]);
    const results = parseClassificationResponse(json);
    expect(results).toHaveLength(1);
    expect(results[0]!.email).toBe("precise@test.com");
    expect(results[0]!.senderType).toBe("automated");
    expect(results[0]!.confidence).toBe(0.95);
  });
});

describe("classifySendersWithLlm", () => {
  it("returns a Map keyed by sender email", async () => {
    const senders = [makeSender({ senderEmail: "a@test.com" }), makeSender({ senderEmail: "b@test.com" })];

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { email: "a@test.com", senderType: "human", confidence: 0.9 },
                { email: "b@test.com", senderType: "newsletter", confidence: 0.8 },
              ]),
            },
          ],
        }),
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);
    expect(results.size).toBe(2);
    expect(results.get("a@test.com")?.senderType).toBe("human");
    expect(results.get("b@test.com")?.senderType).toBe("newsletter");
  });

  it("marks senders as unknown when API returns unparseable response", async () => {
    const senders = [makeSender({ senderEmail: "fail@test.com" })];

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not valid json" }],
        }),
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);
    expect(results.get("fail@test.com")?.senderType).toBe("unknown");
    expect(results.get("fail@test.com")?.confidence).toBe(0);
  });

  it("retries once on parse failure before marking unknown", async () => {
    const senders = [makeSender({ senderEmail: "retry@test.com" })];

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "bad json" }] })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify([{ email: "retry@test.com", senderType: "human", confidence: 0.85 }]),
          },
        ],
      });

    const mockClient = { messages: { create: mockCreate } };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);
    // Called twice (initial + 1 retry)
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(results.get("retry@test.com")?.senderType).toBe("human");
  });

  it("retries when the response is only a partial batch", async () => {
    const senders = [makeSender({ senderEmail: "a@test.com" }), makeSender({ senderEmail: "b@test.com" })];

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify([{ email: "a@test.com", senderType: "human", confidence: 0.91 }]),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { email: "a@test.com", senderType: "human", confidence: 0.91 },
              { email: "b@test.com", senderType: "newsletter", confidence: 0.77 },
            ]),
          },
        ],
      });

    const mockClient = { messages: { create: mockCreate } };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(results.get("a@test.com")?.senderType).toBe("human");
    expect(results.get("b@test.com")?.senderType).toBe("newsletter");
  });

  it("marks unknown after two consecutive parse failures", async () => {
    const senders = [makeSender({ senderEmail: "bad@test.com" })];

    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "bad json" }] });

    const mockClient = { messages: { create: mockCreate } };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(results.get("bad@test.com")?.senderType).toBe("unknown");
  });

  it("calls onProgress after each batch", async () => {
    const senders = [makeSender({ senderEmail: "prog@test.com" })];

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify([{ email: "prog@test.com", senderType: "company", confidence: 0.75 }]),
            },
          ],
        }),
      },
    };

    const onProgress = vi.fn();

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    await classifySendersWithLlm(senders, mockClient as any, [], onProgress);
    expect(onProgress).toHaveBeenCalledWith({ batch: 1, total: 1 });
  });

  it("swallows onProgress callback failures", async () => {
    const senders = [makeSender({ senderEmail: "progress@test.com" })];

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify([{ email: "progress@test.com", senderType: "company", confidence: 0.75 }]),
            },
          ],
        }),
      },
    };

    const onProgress = vi.fn(() => {
      throw new Error("progress exploded");
    });

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, [], onProgress);

    expect(onProgress).toHaveBeenCalledWith({ batch: 1, total: 1 });
    expect(results.get("progress@test.com")?.senderType).toBe("company");
  });

  it("handles API errors by marking senders as unknown", async () => {
    const senders = [makeSender({ senderEmail: "error@test.com" })];

    const mockClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API error")),
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
    const results = await classifySendersWithLlm(senders, mockClient as any, []);
    expect(results.get("error@test.com")?.senderType).toBe("unknown");
  });
});
