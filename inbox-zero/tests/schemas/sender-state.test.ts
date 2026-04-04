import { describe, expect, it } from "vitest";
import { SenderStateFileSchema } from "../../src/schemas/sender-state.js";

describe("SenderStateFileSchema", () => {
  const validSender = {
    senderEmail: "test@example.com",
    senderName: "Test",
    emailCount: 10,
    firstEmailDate: "2025-01-01T00:00:00.000Z",
    lastEmailDate: "2026-03-01T00:00:00.000Z",
    gmailCategory: "primary",
    unreadRatio: 0.2,
    threadCount: 5,
    sampleSubjects: ["Hello"],
    surprisesFlag: false,
  };

  it("accepts a valid sender-state file", () => {
    const file = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-18T12:00:00Z",
      senders: [validSender],
    };
    expect(SenderStateFileSchema.safeParse(file).success).toBe(true);
  });

  it("accepts senders with enrichment fields", () => {
    const file = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-18T12:00:00Z",
      senders: [
        {
          ...validSender,
          senderType: "newsletter",
          senderTypeConfidence: 0.9,
          senderTypeSource: "heuristic",
          reviewedSenderType: "company",
          reviewedAt: "2026-03-18T14:00:00Z",
          processedAt: "2026-03-18T15:00:00Z",
        },
      ],
    };
    expect(SenderStateFileSchema.safeParse(file).success).toBe(true);
  });

  it("rejects version !== 1", () => {
    const file = { version: 2, mailbox: "x", generatedAt: "2026-03-18T12:00:00Z", senders: [] };
    expect(SenderStateFileSchema.safeParse(file).success).toBe(false);
  });

  it("rejects duplicate senderEmail entries", () => {
    const file = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-18T12:00:00Z",
      senders: [validSender, { ...validSender }],
    };

    expect(SenderStateFileSchema.safeParse(file).success).toBe(false);
  });
});
