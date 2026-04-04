/**
 * llm-classifier.test.ts
 *
 * Tests for the provider-agnostic LLM classifier.
 * All provider interactions are mocked — no real API calls.
 */

import { describe, expect, it, vi } from "vitest";
import type { ClassificationProvider } from "../../src/classify/llm-classifier.js";
import { AnthropicProvider, classifyBatch, proposeTaxonomy } from "../../src/classify/llm-classifier.js";
import type { ThreadSummary } from "../../src/classify/thread-collapser.js";
import type { ThreadClassification } from "../../src/schemas/classification.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal ThreadSummary for testing.
 * lastDate defaults to "recent" (within 12 months).
 */
function makeThread(threadId: string, overrides: Partial<ThreadSummary> & { lastDate?: Date } = {}): ThreadSummary {
  const { lastDate, ...rest } = overrides;
  const now = new Date();
  const recentDate = lastDate ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  return {
    threadId,
    senderEmail: "sender@example.com",
    subject: "Test subject",
    participants: ["sender@example.com"],
    dateRange: {
      first: new Date(recentDate.getTime() - 60 * 60 * 1000),
      last: recentDate,
    },
    content: "This is test email content.",
    messageCount: 2,
    ...rest,
  };
}

function makeClassification(threadId: string, overrides: Partial<ThreadClassification> = {}): ThreadClassification {
  return {
    threadId,
    category: "newsletter",
    confidence: 0.9,
    actionable: false,
    summary: "A newsletter email.",
    classifiedBy: "llm",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MockProvider — returns predetermined responses
// ---------------------------------------------------------------------------

class MockProvider implements ClassificationProvider {
  private classifyResponses: Map<string, { ok: true; value: ThreadClassification } | { ok: false; error: string }> =
    new Map();
  private taxonomyResponse: { ok: true; value: string[] } | { ok: false; error: string } = {
    ok: true,
    value: ["newsletter", "transactional", "personal"],
  };

  setClassifyResponse(
    threadId: string,
    response: { ok: true; value: ThreadClassification } | { ok: false; error: string },
  ): void {
    this.classifyResponses.set(threadId, response);
  }

  setTaxonomyResponse(response: { ok: true; value: string[] } | { ok: false; error: string }): void {
    this.taxonomyResponse = response;
  }

  async classify(
    _content: string,
    _existingCategories: string[],
    threadId: string,
  ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
    const response = this.classifyResponses.get(threadId);
    if (response === undefined) {
      return {
        ok: true,
        value: makeClassification(threadId),
      };
    }
    return response;
  }

  async proposeTaxonomy(
    _sampleContent: string[],
  ): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
    return this.taxonomyResponse;
  }
}

// ---------------------------------------------------------------------------
// Tests: ClassificationProvider interface
// ---------------------------------------------------------------------------

describe("ClassificationProvider interface", () => {
  it("classify() accepts content, existingCategories, threadId and returns Result<ThreadClassification>", async () => {
    const provider = new MockProvider();
    const thread = makeThread("t1");

    provider.setClassifyResponse("t1", {
      ok: true,
      value: makeClassification("t1", { category: "newsletter", confidence: 0.95 }),
    });

    const result = await provider.classify(thread.content, ["newsletter", "transactional"], "t1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.threadId).toBe("t1");
      expect(result.value.category).toBe("newsletter");
      expect(result.value.confidence).toBe(0.95);
      expect(result.value.classifiedBy).toBe("llm");
    }
  });

  it("classify() can return ok: false on provider error", async () => {
    const provider = new MockProvider();
    provider.setClassifyResponse("t2", { ok: false, error: "provider error" });

    const result = await provider.classify("content", [], "t2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("provider error");
    }
  });

  it("proposeTaxonomy() accepts sample content array and returns Result<string[]>", async () => {
    const provider = new MockProvider();
    provider.setTaxonomyResponse({ ok: true, value: ["newsletter", "github-notification", "personal"] });

    const result = await provider.proposeTaxonomy(["email body 1", "email body 2"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("newsletter");
      expect(result.value.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: classifyBatch
// ---------------------------------------------------------------------------

describe("classifyBatch()", () => {
  it("returns a ThreadClassification for each thread", async () => {
    const provider = new MockProvider();
    const threads = [makeThread("t1"), makeThread("t2"), makeThread("t3")];

    const results = await classifyBatch(threads, provider, ["newsletter"]);

    expect(results).toHaveLength(3);
    const ids = results.map((r) => r.threadId);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).toContain("t3");
  });

  it("marks failed classifications as uncategorized with confidence 0", async () => {
    const provider = new MockProvider();
    const threads = [makeThread("t1"), makeThread("t2")];

    provider.setClassifyResponse("t1", { ok: false, error: "parse error" });
    // t2 uses default success response

    const results = await classifyBatch(threads, provider, []);

    const t1Result = results.find((r) => r.threadId === "t1");
    const t2Result = results.find((r) => r.threadId === "t2");

    if (t1Result === undefined) throw new Error("t1 result not found");
    if (t2Result === undefined) throw new Error("t2 result not found");

    expect(t1Result.category).toBe("uncategorized");
    expect(t1Result.confidence).toBe(0);
    expect(t1Result.classifiedBy).toBe("llm");

    expect(t2Result.category).not.toBe("uncategorized");
  });

  it("sets actionable=false for threads older than 12 months regardless of provider value", async () => {
    const provider = new MockProvider();
    const now = new Date();
    const oldDate = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000); // 400 days ago

    const oldThread = makeThread("old-thread", { lastDate: oldDate });
    const newThread = makeThread("new-thread");

    // Provider says both are actionable
    provider.setClassifyResponse("old-thread", {
      ok: true,
      value: makeClassification("old-thread", { actionable: true }),
    });
    provider.setClassifyResponse("new-thread", {
      ok: true,
      value: makeClassification("new-thread", { actionable: true }),
    });

    const results = await classifyBatch([oldThread, newThread], provider, []);

    const oldResult = results.find((r) => r.threadId === "old-thread");
    const newResult = results.find((r) => r.threadId === "new-thread");

    if (oldResult === undefined) throw new Error("old-thread result not found");
    if (newResult === undefined) throw new Error("new-thread result not found");

    // Old thread must have actionable forced to false
    expect(oldResult.actionable).toBe(false);
    // New thread keeps provider's value
    expect(newResult.actionable).toBe(true);
  });

  it("sets actionable=false for threads exactly at the 12-month boundary (exclusive)", async () => {
    const provider = new MockProvider();
    const now = new Date();
    // 365 days + 1 day over the limit
    const borderDate = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);

    const borderThread = makeThread("border-thread", { lastDate: borderDate });
    provider.setClassifyResponse("border-thread", {
      ok: true,
      value: makeClassification("border-thread", { actionable: true }),
    });

    const results = await classifyBatch([borderThread], provider, []);
    const result = results[0];
    if (result === undefined) throw new Error("border-thread result not found");
    expect(result.actionable).toBe(false);
  });

  it("respects maxConcurrent option (bounded concurrency)", async () => {
    const concurrentCount = { max: 0, current: 0 };
    const trackedProvider: ClassificationProvider = {
      async classify(
        _content,
        _categories,
        threadId,
      ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
        concurrentCount.current++;
        if (concurrentCount.current > concurrentCount.max) {
          concurrentCount.max = concurrentCount.current;
        }
        // Simulate async work
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        concurrentCount.current--;
        return {
          ok: true,
          value: makeClassification(threadId),
        };
      },
      async proposeTaxonomy(_sampleContent) {
        return { ok: true, value: [] };
      },
    };

    const threads = Array.from({ length: 10 }, (_, i) => makeThread(`t${i}`));
    await classifyBatch(threads, trackedProvider, [], { maxConcurrent: 3 });

    // Max concurrent must not exceed the configured limit
    expect(concurrentCount.max).toBeLessThanOrEqual(3);
  });

  it("default maxConcurrent is 5", async () => {
    const concurrentCount = { max: 0, current: 0 };
    const trackedProvider: ClassificationProvider = {
      async classify(
        _content,
        _categories,
        threadId,
      ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
        concurrentCount.current++;
        if (concurrentCount.current > concurrentCount.max) {
          concurrentCount.max = concurrentCount.current;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        concurrentCount.current--;
        return {
          ok: true,
          value: makeClassification(threadId),
        };
      },
      async proposeTaxonomy(_sampleContent) {
        return { ok: true, value: [] };
      },
    };

    const threads = Array.from({ length: 20 }, (_, i) => makeThread(`t${i}`));
    await classifyBatch(threads, trackedProvider, []);

    // Default limit is 5
    expect(concurrentCount.max).toBeLessThanOrEqual(5);
  });

  it("passes existingCategories to the provider", async () => {
    const capturedCategories: string[][] = [];
    const spyProvider: ClassificationProvider = {
      async classify(
        _content,
        existingCategories,
        threadId,
      ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
        capturedCategories.push(existingCategories);
        return { ok: true, value: makeClassification(threadId) };
      },
      async proposeTaxonomy(_sampleContent) {
        return { ok: true, value: [] };
      },
    };

    const categories = ["newsletter", "transactional", "personal"];
    await classifyBatch([makeThread("t1")], spyProvider, categories);

    expect(capturedCategories).toHaveLength(1);
    expect(capturedCategories[0]).toEqual(categories);
  });

  it("all classifications have classifiedBy='llm'", async () => {
    const provider = new MockProvider();
    const threads = [makeThread("t1"), makeThread("t2")];

    // Even if provider somehow returns rule-classified (unlikely), batch should set llm
    provider.setClassifyResponse("t1", {
      ok: true,
      value: makeClassification("t1", { classifiedBy: "llm" }),
    });

    const results = await classifyBatch(threads, provider, []);
    for (const r of results) {
      expect(r.classifiedBy).toBe("llm");
    }
  });

  it("handles empty thread array", async () => {
    const provider = new MockProvider();
    const results = await classifyBatch([], provider, []);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: proposeTaxonomy
// ---------------------------------------------------------------------------

describe("proposeTaxonomy()", () => {
  it("returns string[] of category names from the provider", async () => {
    const provider = new MockProvider();
    provider.setTaxonomyResponse({
      ok: true,
      value: ["newsletter", "github-notification", "transactional", "personal", "receipts"],
    });

    const threads = [makeThread("t1"), makeThread("t2"), makeThread("t3")];
    const categories = await proposeTaxonomy(threads, provider);

    expect(categories).toContain("newsletter");
    expect(categories.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array when provider fails", async () => {
    const provider = new MockProvider();
    provider.setTaxonomyResponse({ ok: false, error: "provider error" });

    const threads = [makeThread("t1")];
    const categories = await proposeTaxonomy(threads, provider);

    expect(categories).toEqual([]);
  });

  it("caps sample at 1000 threads (does not crash on large input)", async () => {
    const capturedSamples: string[][] = [];
    const spyProvider: ClassificationProvider = {
      async classify(
        _content,
        _categories,
        threadId,
      ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
        return { ok: true, value: makeClassification(threadId) };
      },
      async proposeTaxonomy(sampleContent): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
        capturedSamples.push(sampleContent);
        return { ok: true, value: [] };
      },
    };

    // Create 1500 threads — should be capped at 1000
    const threads = Array.from({ length: 1500 }, (_, i) => makeThread(`t${i}`));
    await proposeTaxonomy(threads, spyProvider);

    expect(capturedSamples).toHaveLength(1);
    expect(capturedSamples[0]!.length).toBeLessThanOrEqual(1000);
  });

  it("sends content summaries (not raw thread objects) to provider", async () => {
    const capturedSamples: string[][] = [];
    const spyProvider: ClassificationProvider = {
      async classify(
        _content,
        _categories,
        threadId,
      ): Promise<{ ok: true; value: ThreadClassification } | { ok: false; error: string }> {
        return { ok: true, value: makeClassification(threadId) };
      },
      async proposeTaxonomy(sampleContent): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
        capturedSamples.push(sampleContent);
        return { ok: true, value: [] };
      },
    };

    const thread = makeThread("t1", { subject: "My Subject", content: "My content body" });
    await proposeTaxonomy([thread], spyProvider);

    expect(capturedSamples[0]).toBeDefined();
    const sample = capturedSamples[0]!;
    // Each entry should be a string summarising the thread
    expect(typeof sample[0]).toBe("string");
    // Should include recognizable thread info
    expect(sample[0]).toContain("My Subject");
  });
});

// ---------------------------------------------------------------------------
// Tests: AnthropicProvider
// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  it("can be constructed with an apiKey", () => {
    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    expect(provider).toBeDefined();
  });

  it("uses default model claude-haiku-4-5-20251001 when no model specified", () => {
    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    // Access via reflection — model is internal but testable
    expect((provider as unknown as { model: string }).model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses custom model when specified", () => {
    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123", model: "claude-opus-4-5" });
    expect((provider as unknown as { model: string }).model).toBe("claude-opus-4-5");
  });

  it("classify() returns ok: false when SDK response cannot be parsed as ThreadClassification", async () => {
    // Mock Anthropic client to return invalid JSON
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"invalid": "shape"}' }],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    // Inject mock client via internal property
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.classify("email content", ["newsletter"], "thread-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid LLM response");
    }
  });

  it("classify() returns ok: true when SDK returns valid ThreadClassification JSON", async () => {
    const validResponse = {
      threadId: "thread-1",
      category: "newsletter",
      confidence: 0.9,
      actionable: false,
      summary: "A newsletter about products.",
      classifiedBy: "llm" as const,
    };

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: JSON.stringify(validResponse) }],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.classify("email content", ["newsletter"], "thread-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.threadId).toBe("thread-1");
      expect(result.value.category).toBe("newsletter");
      expect(result.value.confidence).toBe(0.9);
    }
  });

  it("classify() returns ok: false when SDK throws", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API error")),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.classify("email content", [], "thread-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
  });

  it("classify() returns ok: false when response content is not JSON", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Sorry, I cannot classify that." }],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.classify("email content", [], "thread-1");

    expect(result.ok).toBe(false);
  });

  it("proposeTaxonomy() returns ok: true with category names array from SDK", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify(["newsletter", "github-notification", "transactional", "personal", "receipts"]),
            },
          ],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.proposeTaxonomy(["sample content 1", "sample content 2"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
      expect(result.value).toContain("newsletter");
    }
  });

  it("proposeTaxonomy() returns ok: false when SDK throws", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("rate limit")),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.proposeTaxonomy(["sample"]);

    expect(result.ok).toBe(false);
  });

  it("proposeTaxonomy() returns ok: false when response is not a string array", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"categories": ["a", "b"]}' }],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    const result = await provider.proposeTaxonomy(["sample"]);

    expect(result.ok).toBe(false);
  });

  it("classify() sends existingCategories in the prompt", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not json" }],
        }),
      },
    };

    const provider = new AnthropicProvider({ apiKey: "test_mock_key_123" });
    (provider as unknown as { client: typeof mockClient }).client = mockClient;

    await provider.classify("email content", ["newsletter", "transactional"], "t1");

    const createCall = mockClient.messages.create.mock.calls[0];
    if (createCall === undefined) throw new Error("create was not called");
    const callArg = createCall[0] as { messages: Array<{ content: string }> };
    const promptText = callArg.messages[0]?.content ?? "";
    expect(promptText).toContain("newsletter");
    expect(promptText).toContain("transactional");
  });
});
