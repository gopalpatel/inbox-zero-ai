import { describe, expect, it } from "vitest";
import { BatchManifestSchema } from "../../src/schemas/batch-manifest.js";
import { DecisionLogSchema } from "../../src/schemas/decision-log.js";
import { EmailMetadataSchema } from "../../src/schemas/email-metadata.js";
import { SenderStateFileSchema } from "../../src/schemas/sender-state.js";

describe("contract: O365 output validates Gmail schemas", () => {
  it("EmailMetadata accepts O365-produced message", () => {
    const o365Message = {
      messageId: "AAMkADAwATZi",
      threadId: "AAQkADAwATZi",
      sender: { email: "someone@example.com", name: "Someone" },
      recipients: { to: ["mailbox@example.com"], cc: [] },
      subject: "Test message",
      dateReceived: "2026-03-23T10:00:00.000Z",
      gmailCategory: "unknown",
      labels: ["INBOX", "UNREAD"],
      isUnread: true,
      snippet: "This is a test",
    };
    const result = EmailMetadataSchema.safeParse(o365Message);
    expect(result.success).toBe(true);
  });

  it("EmailMetadata rejects O365 message missing required fields", () => {
    const result = EmailMetadataSchema.safeParse({ messageId: "x" });
    expect(result.success).toBe(false);
  });

  it("SenderStateFile accepts O365-produced sender state", () => {
    const state = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-23T10:00:00.000Z",
      senders: [
        {
          senderEmail: "someone@example.com",
          senderName: "Someone",
          emailCount: 50,
          firstEmailDate: "2025-01-01T00:00:00Z",
          lastEmailDate: "2026-03-23T10:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.5,
          threadCount: 25,
          sampleSubjects: ["Hello"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
      ],
    };
    const result = SenderStateFileSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it("DecisionLog accepts O365-produced decisions", () => {
    const log = {
      version: 1,
      decisions: [
        {
          runId: "run-o365-2026-03-23",
          senderEmail: "someone@example.com",
          senderName: "Someone",
          presentedSenderType: "human",
          senderTypeFeedback: "none",
          systemRecommendation: "filter",
          userDecision: "filter",
          batchId: "batch-o365-01",
          timestamp: "2026-03-23T10:00:00.000Z",
          emailCount: 50,
          messagesArchived: 48,
          actionsTaken: [],
        },
      ],
    };
    const result = DecisionLogSchema.safeParse(log);
    expect(result.success).toBe(true);
  });

  it("BatchManifest accepts O365-produced batch manifest", () => {
    const manifest = {
      version: 1,
      runId: "run-o365-2026-03-23",
      batchId: "batch-o365-01",
      batchType: "automated",
      groupingReason: "O365 automated senders",
      presentedRecommendation: "unsubscribe",
      summary: {
        senderCount: 1,
        totalEmailCount: 50,
        averageUnreadRatio: 0.5,
      },
      status: "prepared",
      createdAt: "2026-03-23T10:00:00.000Z",
      senders: [
        {
          senderEmail: "noreply@example.com",
          senderName: "Example",
          emailCount: 50,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-23T10:00:00.000Z",
          presentedSenderType: "automated",
          systemRecommendation: "unsubscribe",
          userDecision: "unsubscribe",
          filterStatus: "pending",
          archiveStatus: "pending",
          logStatus: "pending",
          stateStatus: "pending",
          sheetStatus: "pending",
          messagesArchived: 0,
        },
      ],
    };
    const result = BatchManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });
});
