import { describe, expect, it } from "vitest";
import { SenderStateFileSchema } from "../../src/schemas/sender-state.js";

describe("enrichment produces contract-compatible output", () => {
  it("enriched sender-state validates against Gmail schema", () => {
    const state = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: new Date().toISOString(),
      senders: [
        {
          senderEmail: "test@example.com",
          senderName: "Test",
          emailCount: 10,
          firstEmailDate: "2025-01-01T00:00:00Z",
          lastEmailDate: "2026-03-01T00:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.5,
          threadCount: 5,
          sampleSubjects: ["Hello"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
          senderType: "human",
          senderTypeConfidence: 0.9,
          senderTypeSource: "heuristic",
        },
      ],
    };
    expect(SenderStateFileSchema.safeParse(state).success).toBe(true);
  });
});
