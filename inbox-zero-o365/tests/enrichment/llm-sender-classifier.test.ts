import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { classifySendersWithLlm, parseClassificationResponse } from "../../src/enrichment/llm-sender-classifier.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";

function makeSender(senderEmail: string): SenderStats {
  return {
    senderEmail,
    senderName: senderEmail,
    emailCount: 5,
    firstEmailDate: "2026-03-01T00:00:00.000Z",
    lastEmailDate: "2026-03-20T00:00:00.000Z",
    gmailCategory: "unknown",
    unreadRatio: 0.2,
    threadCount: 3,
    sampleSubjects: ["Hello"],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
  };
}

describe("parseClassificationResponse", () => {
  it("parses a valid classification array", () => {
    const response = JSON.stringify([
      { email: "one@example.com", senderType: "human", confidence: 0.91 },
      { email: "two@example.com", senderType: "newsletter", confidence: 0.73 },
    ]);

    expect(parseClassificationResponse(response)).toEqual([
      { email: "one@example.com", senderType: "human", confidence: 0.91 },
      { email: "two@example.com", senderType: "newsletter", confidence: 0.73 },
    ]);
  });

  it("keeps scanning when an earlier parseable array has no valid classification entries", () => {
    const response = [
      "Here is a scratch array that should be ignored:",
      '[{"note":"not-a-classification"}]',
      "Final answer:",
      '[{"email":"real@example.com","senderType":"company","confidence":0.88}]',
    ].join("\n");

    expect(parseClassificationResponse(response)).toEqual([
      { email: "real@example.com", senderType: "company", confidence: 0.88 },
    ]);
  });

  it("ignores out-of-batch rows and later duplicates when classifying a batch", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { email: "fewshot@example.com", senderType: "human", confidence: 0.99 },
                { email: "alpha@example.com", senderType: "company", confidence: 0.81 },
                { email: "ALPHA@example.com", senderType: "newsletter", confidence: 0.12 },
                { email: "beta@example.com", senderType: "automated", confidence: 0.67 },
              ]),
            },
          ],
        }),
      },
    } as unknown as Anthropic;

    const results = await classifySendersWithLlm(
      [makeSender("alpha@example.com"), makeSender("beta@example.com")],
      client,
      [{ email: "fewshot@example.com", senderType: "human", context: "few-shot example" }],
    );

    expect(results).toEqual(
      new Map([
        ["alpha@example.com", { senderType: "company", confidence: 0.81 }],
        ["beta@example.com", { senderType: "automated", confidence: 0.67 }],
      ]),
    );
  });
});
