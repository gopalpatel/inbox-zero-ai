import { describe, expect, it } from "vitest";
import { DecisionEntrySchema, DecisionLogSchema } from "../../src/schemas/decision-log.js";

describe("DecisionEntrySchema", () => {
  const validEntry = {
    runId: "run-001",
    senderEmail: "news@example.com",
    senderName: "Example News",
    presentedSenderType: "newsletter",
    senderTypeFeedback: "none",
    systemRecommendation: "unsubscribe",
    userDecision: "unsubscribe",
    batchId: "newsletter-batch-1",
    timestamp: "2026-03-18T14:30:00Z",
    emailCount: 2340,
    messagesArchived: 2340,
    actionsTaken: ["filter_created", "archived_2340"],
  };

  it("accepts a valid entry", () => {
    expect(DecisionEntrySchema.safeParse(validEntry).success).toBe(true);
  });

  it("accepts entry with sender type correction", () => {
    const corrected = { ...validEntry, reviewedSenderType: "company", senderTypeFeedback: "corrected" };
    expect(DecisionEntrySchema.safeParse(corrected).success).toBe(true);
  });

  it("rejects corrected feedback without reviewedSenderType", () => {
    expect(
      DecisionEntrySchema.safeParse({ ...validEntry, senderTypeFeedback: "corrected", reviewedSenderType: undefined })
        .success,
    ).toBe(false);
  });

  it("rejects invalid senderTypeFeedback", () => {
    expect(DecisionEntrySchema.safeParse({ ...validEntry, senderTypeFeedback: "maybe" }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(DecisionEntrySchema.safeParse({ ...validEntry, runId: undefined }).success).toBe(false);
    expect(DecisionEntrySchema.safeParse({ ...validEntry, senderEmail: undefined }).success).toBe(false);
  });

  it("rejects invalid timestamps", () => {
    expect(DecisionEntrySchema.safeParse({ ...validEntry, timestamp: "not-a-date" }).success).toBe(false);
  });
});

describe("DecisionLogSchema", () => {
  it("accepts valid log with version 1", () => {
    const log = { version: 1, decisions: [] };
    expect(DecisionLogSchema.safeParse(log).success).toBe(true);
  });

  it("rejects malformed logs", () => {
    expect(DecisionLogSchema.safeParse({ decisions: [] }).success).toBe(false);
    expect(DecisionLogSchema.safeParse({ version: 1, decisions: {} }).success).toBe(false);
  });
});
