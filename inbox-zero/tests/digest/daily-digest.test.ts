/**
 * daily-digest.test.ts
 *
 * Tests for the daily digest orchestration module.
 * Mocks all external dependencies (GmailClient, ClassificationProvider).
 * Uses temp directories for report output with try/finally cleanup.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result } from "../../src/auth/gmail-client.js";
import * as bodyPullerModule from "../../src/classify/body-puller.js";
import type { ClassificationProvider } from "../../src/classify/llm-classifier.js";
import type { RulesConfig } from "../../src/classify/rule-engine.js";
import { runDigest } from "../../src/digest/daily-digest.js";
import type { ThreadClassification } from "../../src/schemas/classification.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a mock GmailClient with all methods as vi.fn(). */
function createMockClient(): GmailClient {
  return {
    getProfile: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn<() => Promise<Result<void>>>().mockResolvedValue({
      ok: true,
      value: undefined,
    }),
    listLabels: vi.fn<() => Promise<Result<gmail_v1.Schema$Label[]>>>().mockResolvedValue({ ok: true, value: [] }),
    listFilters: vi.fn<() => Promise<Result<gmail_v1.Schema$Filter[]>>>().mockResolvedValue({ ok: true, value: [] }),
    createLabel: vi
      .fn<(name: string) => Promise<Result<gmail_v1.Schema$Label>>>()
      .mockImplementation(async (name: string) => ({
        ok: true,
        value: { id: `label-${name}`, name },
      })),
    createFilter: vi.fn(),
  };
}

/** Creates a mock ClassificationProvider. */
function createMockProvider(): ClassificationProvider {
  return {
    classify: vi.fn(),
    proposeTaxonomy: vi.fn(),
  };
}

/** Creates a minimal raw Gmail message for testing. */
function makeRawMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  dateMs: number;
}): gmail_v1.Schema$Message {
  return {
    id: opts.id,
    threadId: opts.threadId,
    internalDate: String(opts.dateMs),
    labelIds: ["INBOX", "UNREAD"],
    snippet: `Snippet for ${opts.subject}`,
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "Subject", value: opts.subject },
        { name: "To", value: "me@example.com" },
      ],
      mimeType: "text/plain",
      body: {
        data: Buffer.from(`Body of ${opts.subject}`).toString("base64"),
      },
    },
  };
}

/** Creates a ThreadClassification for testing. */
function makeClassification(
  threadId: string,
  actionable: boolean,
  opts: Partial<ThreadClassification> = {},
): ThreadClassification {
  return {
    threadId,
    category: "newsletter",
    confidence: 0.9,
    actionable,
    summary: `Summary for thread ${threadId}`,
    classifiedBy: "llm",
    ...opts,
  };
}

/** Creates a RulesConfig that matches specific senders. */
function makeRulesConfig(senderRules: Record<string, string | null> = {}): RulesConfig {
  return {
    domainRules: {},
    senderRules,
  };
}

/** Creates a temp directory and returns its path. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "digest-test-"));
}

// ---------------------------------------------------------------------------
// Realistic scenario:
// 20 messages across 8 threads.
// Threads t1, t2, t3 are matched by rule engine (sender rules).
//   Rule-matched threads use OLD_MS (>12 months ago) so rule engine marks them
//   non-actionable (newsletters/promos don't need a reply).
// Threads t4, t5, t6, t7, t8 are unmatched → LLM.
//   LLM-classified threads use RECENT_MS (within 12 months).
//   LLM marks t6 and t7 as actionable (boss reply needed, contract renewal).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-17T12:00:00Z");
const RECENT_MS = NOW.getTime() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
const OLD_MS = NOW.getTime() - 400 * 24 * 60 * 60 * 1000; // ~13 months ago → non-actionable

/** Thread IDs for our scenario. */
const THREAD_IDS = {
  t1: "thread-001",
  t2: "thread-002",
  t3: "thread-003",
  t4: "thread-004",
  t5: "thread-005",
  t6: "thread-006",
  t7: "thread-007",
  t8: "thread-008",
};

/**
 * Builds the 20-message mock data set.
 *
 * Thread assignment (messageId → threadId):
 * - msg-001 .. msg-003 → t1 (rule-matched, newsletter@bank.com)
 * - msg-004 .. msg-006 → t2 (rule-matched, promo@shop.com)
 * - msg-007 .. msg-009 → t3 (rule-matched, updates@saas.com)
 * - msg-010 .. msg-012 → t4 (LLM, personal@friend.com)
 * - msg-013 .. msg-014 → t5 (LLM, alerts@service.io)
 * - msg-015 .. msg-016 → t6 (LLM, boss@company.com — actionable)
 * - msg-017 .. msg-018 → t7 (LLM, client@partner.org — actionable)
 * - msg-019 .. msg-020 → t8 (LLM, info@newsletter.net)
 */
function buildMessages(): gmail_v1.Schema$Message[] {
  const msgs: gmail_v1.Schema$Message[] = [];

  const addRecent = (id: string, threadId: string, from: string, subject: string): void => {
    msgs.push(makeRawMessage({ id, threadId, from, subject, dateMs: RECENT_MS }));
  };

  const addOld = (id: string, threadId: string, from: string, subject: string): void => {
    // OLD_MS is >12 months ago → rule engine marks non-actionable
    msgs.push(makeRawMessage({ id, threadId, from, subject, dateMs: OLD_MS }));
  };

  // t1 — rule-matched (old → non-actionable per rule engine)
  addOld("msg-001", THREAD_IDS.t1, "newsletter@bank.com", "Your Monthly Statement");
  addOld("msg-002", THREAD_IDS.t1, "newsletter@bank.com", "Your Monthly Statement (2)");
  addOld("msg-003", THREAD_IDS.t1, "newsletter@bank.com", "Your Monthly Statement (3)");

  // t2 — rule-matched (old → non-actionable)
  addOld("msg-004", THREAD_IDS.t2, "promo@shop.com", "50% Sale Today Only");
  addOld("msg-005", THREAD_IDS.t2, "promo@shop.com", "50% Sale Today Only (2)");
  addOld("msg-006", THREAD_IDS.t2, "promo@shop.com", "50% Sale Today Only (3)");

  // t3 — rule-matched (old → non-actionable)
  addOld("msg-007", THREAD_IDS.t3, "updates@saas.com", "Your invoice is ready");
  addOld("msg-008", THREAD_IDS.t3, "updates@saas.com", "Your invoice is ready (2)");
  addOld("msg-009", THREAD_IDS.t3, "updates@saas.com", "Your invoice is ready (3)");

  // t4 — LLM-classified, not actionable (recent)
  addRecent("msg-010", THREAD_IDS.t4, "personal@friend.com", "Catching up");
  addRecent("msg-011", THREAD_IDS.t4, "personal@friend.com", "Catching up (2)");
  addRecent("msg-012", THREAD_IDS.t4, "personal@friend.com", "Catching up (3)");

  // t5 — LLM-classified, not actionable (recent)
  addRecent("msg-013", THREAD_IDS.t5, "alerts@service.io", "System alert");
  addRecent("msg-014", THREAD_IDS.t5, "alerts@service.io", "System alert (2)");

  // t6 — LLM-classified, ACTIONABLE (recent)
  addRecent("msg-015", THREAD_IDS.t6, "boss@company.com", "Q1 Review");
  addRecent("msg-016", THREAD_IDS.t6, "boss@company.com", "Q1 Review (2)");

  // t7 — LLM-classified, ACTIONABLE (recent)
  addRecent("msg-017", THREAD_IDS.t7, "client@partner.org", "Contract renewal");
  addRecent("msg-018", THREAD_IDS.t7, "client@partner.org", "Contract renewal (2)");

  // t8 — LLM-classified, not actionable (recent)
  addRecent("msg-019", THREAD_IDS.t8, "info@newsletter.net", "Weekly digest");
  addRecent("msg-020", THREAD_IDS.t8, "info@newsletter.net", "Weekly digest (2)");

  return msgs;
}

// ---------------------------------------------------------------------------
// Setup shared rules config (matches t1, t2, t3 by sender)
// ---------------------------------------------------------------------------

const RULES_CONFIG = makeRulesConfig({
  "newsletter@bank.com": "transactional",
  "promo@shop.com": "promotions",
  "updates@saas.com": "transactional",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDigest", () => {
  let client: GmailClient;
  let provider: ClassificationProvider;
  let tmpDir: string;

  beforeEach(() => {
    client = createMockClient();
    provider = createMockProvider();
  });

  // -------------------------------------------------------------------------
  // Query Gmail for messages after `since` date
  // -------------------------------------------------------------------------

  it("queries Gmail with a query string containing the since date", async () => {
    tmpDir = await makeTempDir();

    try {
      // No messages — early return
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [] },
      });

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      expect(client.listMessages).toHaveBeenCalledOnce();
      const callArg = vi.mocked(client.listMessages).mock.calls[0]![0];
      // Query should include "after:2026/03/16"
      expect(callArg).toContain("after:2026/03/16");
      // And exclude spam/trash/drafts/sent
      expect(callArg).toContain("-in:spam");
      expect(callArg).toContain("-in:trash");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // No new messages → "No new mail" summary
  // -------------------------------------------------------------------------

  it("writes 'No new mail' summary and returns early when no messages found", async () => {
    tmpDir = await makeTempDir();

    try {
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [] },
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      expect(result.totalNew).toBe(0);
      expect(result.categorized).toBe(0);
      expect(result.actionable).toBe(0);

      // Report file should exist
      const reportContent = await fs.readFile(result.reportPath, "utf-8");
      expect(reportContent).toContain("No new mail");

      // Provider should not have been called
      expect(provider.classify).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("names the report file with today's date (digest-YYYY-MM-DD.md)", async () => {
    tmpDir = await makeTempDir();

    try {
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [] },
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // File should be named digest-YYYY-MM-DD.md
      expect(result.reportPath).toMatch(/digest-\d{4}-\d{2}-\d{2}\.md$/);
      // Should be written under tmpDir
      expect(result.reportPath.startsWith(tmpDir)).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Full pipeline with 20 messages
  // -------------------------------------------------------------------------

  it("classifies rule-matched threads without calling LLM", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      // listMessages returns all 20
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      // getMessage returns the raw message for each id
      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // LLM provider returns non-actionable for all threads it sees
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false),
      }));

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // LLM should have been called for 5 unmatched threads (t4..t8)
      // NOT for t1, t2, t3 which are rule-matched
      const llmCalls = vi.mocked(provider.classify).mock.calls;
      const llmThreadIds = llmCalls.map((c) => c[2]);

      expect(llmThreadIds).not.toContain(THREAD_IDS.t1);
      expect(llmThreadIds).not.toContain(THREAD_IDS.t2);
      expect(llmThreadIds).not.toContain(THREAD_IDS.t3);

      // t4..t8 should have been sent to LLM
      expect(llmThreadIds).toContain(THREAD_IDS.t4);
      expect(llmThreadIds).toContain(THREAD_IDS.t5);
      expect(llmThreadIds).toContain(THREAD_IDS.t6);
      expect(llmThreadIds).toContain(THREAD_IDS.t7);
      expect(llmThreadIds).toContain(THREAD_IDS.t8);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns correct counts: totalNew=20, categorized=8, actionable=2", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // LLM: t6 and t7 are actionable, rest not
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => {
        const actionable = threadId === THREAD_IDS.t6 || threadId === THREAD_IDS.t7;
        return {
          ok: true as const,
          value: makeClassification(threadId, actionable),
        };
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      expect(result.totalNew).toBe(20);
      expect(result.categorized).toBe(8); // all 8 threads classified
      expect(result.actionable).toBe(2); // t6 and t7
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies labels to all classified threads", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false),
      }));

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // ensureLabelsExist calls listLabels + createLabel for each new category
      expect(client.listLabels).toHaveBeenCalled();

      // batchModifyMessages should have been called (labels applied)
      expect(client.batchModifyMessages).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives non-actionable messages (INBOX removed)", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // All non-actionable
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false),
      }));

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // At least one batchModify call should remove INBOX
      const modifyCalls = vi.mocked(client.batchModifyMessages).mock.calls;
      const removesInbox = modifyCalls.some((call) => {
        const removeLabelIds = call[2]; // third argument
        return Array.isArray(removeLabelIds) && removeLabelIds.includes("INBOX");
      });
      expect(removesInbox).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("labels actionable messages with _triage", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // t6 is actionable
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => {
        const actionable = threadId === THREAD_IDS.t6;
        return {
          ok: true as const,
          value: makeClassification(threadId, actionable),
        };
      });

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // _triage label should have been created
      const createCalls = vi.mocked(client.createLabel).mock.calls;
      const createdNames = createCalls.map((c) => c[0]);
      expect(createdNames).toContain("_triage");

      // At least one batchModify should add the _triage label id
      const modifyCalls = vi.mocked(client.batchModifyMessages).mock.calls;
      const addsTriage = modifyCalls.some((call) => {
        const addLabelIds = call[1]; // second argument
        return Array.isArray(addLabelIds) && addLabelIds.includes("label-_triage");
      });
      expect(addsTriage).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Summary report contents
  // -------------------------------------------------------------------------

  it("writes summary with total new messages, auto-categorized count, and actionable items", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // t6 and t7 are actionable
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => {
        const actionable = threadId === THREAD_IDS.t6 || threadId === THREAD_IDS.t7;
        return {
          ok: true as const,
          value: makeClassification(threadId, actionable, {
            category: actionable ? "personal" : "newsletter",
          }),
        };
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      const reportContent = await fs.readFile(result.reportPath, "utf-8");

      // Should include total new messages
      expect(reportContent).toContain("20");
      // Should mention actionable items
      expect(reportContent).toContain("2");
      // Should include the actionable thread subjects or senders
      expect(reportContent).toContain("boss@company.com");
      expect(reportContent).toContain("client@partner.org");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes category counts in the summary", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false, { category: "newsletter" }),
      }));

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      const reportContent = await fs.readFile(result.reportPath, "utf-8");

      // Digest should list categories (transactional comes from rule engine)
      expect(reportContent).toContain("transactional");
      // newsletter from LLM
      expect(reportContent).toContain("newsletter");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes actionable items with sender and subject in summary", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      // Only t6 is actionable
      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => {
        const actionable = threadId === THREAD_IDS.t6;
        return {
          ok: true as const,
          value: makeClassification(threadId, actionable),
        };
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      const reportContent = await fs.readFile(result.reportPath, "utf-8");

      // Should mention t6's sender and subject
      expect(reportContent).toContain("boss@company.com");
      expect(reportContent).toContain("Q1 Review");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Return values
  // -------------------------------------------------------------------------

  it("returns { totalNew, categorized, actionable, reportPath }", async () => {
    tmpDir = await makeTempDir();

    try {
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [] },
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      expect(typeof result.totalNew).toBe("number");
      expect(typeof result.categorized).toBe("number");
      expect(typeof result.actionable).toBe("number");
      expect(typeof result.reportPath).toBe("string");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reportPath points to a file that exists on disk", async () => {
    tmpDir = await makeTempDir();

    try {
      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [] },
      });

      const since = new Date("2026-03-16T00:00:00Z");
      const result = await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      const stat = await fs.stat(result.reportPath);
      expect(stat.isFile()).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Rule engine only classifies by thread (not per message)
  // -------------------------------------------------------------------------

  it("groups messages by thread before rule-engine classification", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((m) => m.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false),
      }));

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, RULES_CONFIG, tmpDir);

      // Provider should be called once per unmatched thread (not per message)
      // 5 unmatched threads: t4, t5, t6, t7, t8
      const llmCallCount = vi.mocked(provider.classify).mock.calls.length;
      expect(llmCallCount).toBe(5);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // promotions rule-matched thread has no actions label but gets archived
  // -------------------------------------------------------------------------

  it("rule-matched non-actionable threads are archived", async () => {
    tmpDir = await makeTempDir();

    try {
      // Just 1 message rule-matched to "promotions", old → non-actionable per rule engine
      // (>12 months old so rule engine sets actionable=false)
      const messages = [
        makeRawMessage({
          id: "msg-001",
          threadId: "thread-promo",
          from: "promo@shop.com",
          subject: "Big Sale",
          dateMs: OLD_MS,
        }),
      ];

      const rules = makeRulesConfig({ "promo@shop.com": "promotions" });

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [{ id: "msg-001", threadId: "thread-promo" }] },
      });

      vi.mocked(client.getMessage).mockResolvedValue({
        ok: true,
        value: messages[0]!,
      });

      const since = new Date("2026-03-16T00:00:00Z");
      await runDigest(since, client, provider, rules, tmpDir);

      // Rule engine matched → no LLM calls
      expect(provider.classify).not.toHaveBeenCalled();

      // Non-actionable rule-match → archive (INBOX removed)
      const modifyCalls = vi.mocked(client.batchModifyMessages).mock.calls;
      const removesInbox = modifyCalls.some((call) => {
        const removeLabelIds = call[2];
        return Array.isArray(removeLabelIds) && removeLabelIds.includes("INBOX");
      });
      expect(removesInbox).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects when Gmail pagination fails after the first page", async () => {
    tmpDir = await makeTempDir();

    try {
      vi.mocked(client.listMessages)
        .mockResolvedValueOnce({
          ok: true,
          value: {
            messages: [{ id: "msg-001", threadId: THREAD_IDS.t1 }],
            nextPageToken: "page-2",
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          error: "pagination failed",
        });

      await expect(runDigest(new Date("2026-03-16T00:00:00Z"), client, provider, RULES_CONFIG, tmpDir)).rejects.toThrow(
        /Failed to list messages: pagination failed/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Failure modes — partial metadata, body pull, label creation, label apply
  // -------------------------------------------------------------------------

  it("throws when any metadata fetch fails", async () => {
    tmpDir = await makeTempDir();

    try {
      // 10 stubs; make 9 succeed and 1 fail. Any loss should abort the digest.
      const stubs = Array.from({ length: 10 }, (_, i) => ({
        id: `msg-f${String(i + 1).padStart(3, "0")}`,
        threadId: `thread-f${String(i + 1).padStart(3, "0")}`,
      }));

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: stubs },
      });

      // First 9 succeed, last one fails.
      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const index = stubs.findIndex((s) => s.id === id);
        if (index < 9) {
          return {
            ok: true,
            value: makeRawMessage({
              id,
              threadId: stubs[index]!.threadId,
              from: "test@example.com",
              subject: `Subject ${id}`,
              dateMs: RECENT_MS,
            }),
          };
        }
        return { ok: false, error: `Fetch failed for ${id}` };
      });

      await expect(runDigest(new Date("2026-03-16T00:00:00Z"), client, provider, RULES_CONFIG, tmpDir)).rejects.toThrow(
        /Failed to fetch metadata for 1\/10 new messages/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when body pull fails instead of classifying as uncategorized", async () => {
    tmpDir = await makeTempDir();

    // Spy on pullBodies and make it return a failure for this test.
    const pullBodiesSpy = vi.spyOn(bodyPullerModule, "pullBodies").mockResolvedValue({
      ok: false,
      error: "body fetch network error",
    });

    try {
      // Single message, unmatched by rules → needs body pull for LLM
      const stubs = [{ id: "msg-bp-001", threadId: "thread-bp-001" }];

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: stubs },
      });

      vi.mocked(client.getMessage).mockResolvedValue({
        ok: true,
        value: makeRawMessage({
          id: "msg-bp-001",
          threadId: "thread-bp-001",
          from: "unknown@example.com",
          subject: "Test body pull failure",
          dateMs: RECENT_MS,
        }),
      });

      await expect(
        runDigest(
          new Date("2026-03-16T00:00:00Z"),
          client,
          provider,
          makeRulesConfig(), // empty rules → all unmatched
          tmpDir,
        ),
      ).rejects.toThrow(/Body pull failed:.*Cannot classify unmatched threads/);
    } finally {
      pullBodiesSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when label creation fails", async () => {
    tmpDir = await makeTempDir();

    try {
      // Single rule-matched message (so no body pull / LLM needed)
      const messages = [
        makeRawMessage({
          id: "msg-lc-001",
          threadId: "thread-lc-001",
          from: "promo@shop.com",
          subject: "Sale",
          dateMs: OLD_MS,
        }),
      ];

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: { messages: [{ id: "msg-lc-001", threadId: "thread-lc-001" }] },
      });

      vi.mocked(client.getMessage).mockResolvedValue({
        ok: true,
        value: messages[0]!,
      });

      // Make listLabels fail → ensureLabelsExist returns ok: false
      vi.mocked(client.listLabels).mockResolvedValue({
        ok: false,
        error: "labels API down",
      });

      await expect(
        runDigest(
          new Date("2026-03-16T00:00:00Z"),
          client,
          provider,
          makeRulesConfig({ "promo@shop.com": "promotions" }),
          tmpDir,
        ),
      ).rejects.toThrow(/Failed to create labels: labels API down/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when label application fails", async () => {
    tmpDir = await makeTempDir();

    try {
      const messages = buildMessages();

      vi.mocked(client.listMessages).mockResolvedValue({
        ok: true,
        value: {
          messages: messages.map((m) => ({ id: m.id!, threadId: m.threadId! })),
        },
      });

      vi.mocked(client.getMessage).mockImplementation(async (id: string) => {
        const msg = messages.find((message) => message.id === id);
        if (msg === undefined) return { ok: false, error: `Not found: ${id}` };
        return { ok: true, value: msg };
      });

      vi.mocked(provider.classify).mockImplementation(async (_content: string, _cats: string[], threadId: string) => ({
        ok: true as const,
        value: makeClassification(threadId, false),
      }));

      // Labels are created fine, but batchModify fails → applyClassifications returns ok: false
      vi.mocked(client.batchModifyMessages).mockResolvedValue({
        ok: false,
        error: "modify failed",
      });

      await expect(runDigest(new Date("2026-03-16T00:00:00Z"), client, provider, RULES_CONFIG, tmpDir)).rejects.toThrow(
        /Failed to apply labels/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
