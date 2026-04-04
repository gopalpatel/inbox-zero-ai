import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient } from "../../src/auth/gmail-client.js";
import type { ThreadClassification } from "../../src/schemas/classification.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

vi.mock("../../src/classify/body-puller.js", () => ({
  pullBodies: vi.fn(),
}));

vi.mock("../../src/classify/llm-classifier.js", () => ({
  classifyBatch: vi.fn(),
}));

import { pullBodies } from "../../src/classify/body-puller.js";
import { classifyBatch } from "../../src/classify/llm-classifier.js";
import { runClassification } from "../../src/classify/run-classification.js";

function makeEmail(opts: {
  messageId: string;
  threadId: string;
  senderEmail: string;
  subject?: string;
}): EmailMetadata {
  return {
    messageId: opts.messageId,
    threadId: opts.threadId,
    sender: {
      email: opts.senderEmail,
      name: "",
    },
    recipients: { to: [], cc: [] },
    subject: opts.subject ?? "(no subject)",
    dateReceived: new Date("2026-03-17T09:00:00Z"),
    gmailCategory: "unknown",
    labels: [],
    isUnread: true,
    snippet: "",
  };
}

function makeClassification(
  threadId: string,
  category: string,
  actionable = false,
  classifiedBy: "rule" | "llm" = "llm",
): ThreadClassification {
  return {
    threadId,
    category,
    confidence: classifiedBy === "rule" ? 1 : 0.8,
    actionable,
    summary: classifiedBy === "rule" ? "" : "LLM summary",
    classifiedBy,
  };
}

function makeClient(): GmailClient {
  return {
    getProfile: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn(),
    listLabels: vi.fn(),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
  } as GmailClient;
}

describe("runClassification()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs deterministic rules before body pulls and only fetches unmatched threads", async () => {
    const emails: EmailMetadata[] = [
      makeEmail({
        messageId: "msg-rule-1",
        threadId: "thread-rule",
        senderEmail: "alerts@bank.com",
        subject: "Bank alert",
      }),
      makeEmail({
        messageId: "msg-llm-1",
        threadId: "thread-llm",
        senderEmail: "friend@example.com",
        subject: "Need a reply",
      }),
      makeEmail({
        messageId: "msg-llm-2",
        threadId: "thread-llm",
        senderEmail: "friend@example.com",
        subject: "Need a reply",
      }),
    ];

    vi.mocked(pullBodies).mockResolvedValue({
      ok: true,
      value: new Map([
        ["msg-llm-1", "Can you help with this?"],
        ["msg-llm-2", "Following up."],
      ]),
    });
    vi.mocked(classifyBatch).mockResolvedValue([makeClassification("thread-llm", "personal", true)]);

    const result = await runClassification({
      client: makeClient(),
      emails,
      dataDir: "/tmp/inbox-zero-run-classification",
      rulesConfig: {
        domainRules: { "bank.com": "financial" },
        senderRules: {},
      },
      provider: {
        classify: vi.fn(),
        proposeTaxonomy: vi.fn(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(pullBodies).toHaveBeenCalledWith({
      client: expect.any(Object),
      messageIds: ["msg-llm-1", "msg-llm-2"],
      dataDir: "/tmp/inbox-zero-run-classification",
    });

    expect(classifyBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          threadId: "thread-llm",
          senderEmail: "friend@example.com",
        }),
      ],
      expect.any(Object),
      ["financial"],
    );

    expect(result.value.ruleClassifiedCount).toBe(1);
    expect(result.value.llmClassifiedCount).toBe(1);
    expect(result.value.threadCount).toBe(2);
    expect(result.value.unmatchedCount).toBe(1);
    expect(result.value.pulledBodyCount).toBe(2);
    expect(result.value.threadToMessageIds.get("thread-rule")).toEqual(["msg-rule-1"]);
    expect(result.value.threadToMessageIds.get("thread-llm")).toEqual(["msg-llm-1", "msg-llm-2"]);
  });

  it("returns an error when unmatched-thread body pulls fail", async () => {
    const emails: EmailMetadata[] = [
      makeEmail({
        messageId: "msg-1",
        threadId: "thread-1",
        senderEmail: "friend@example.com",
      }),
    ];

    vi.mocked(pullBodies).mockResolvedValue({
      ok: false,
      error: "checkpoint write failed",
    });

    const result = await runClassification({
      client: makeClient(),
      emails,
      dataDir: "/tmp/inbox-zero-run-classification",
      provider: {
        classify: vi.fn(),
        proposeTaxonomy: vi.fn(),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Failed to pull bodies for unmatched threads/);
    expect(result.error).toMatch(/checkpoint write failed/);
    expect(classifyBatch).not.toHaveBeenCalled();
  });
});
