/**
 * full-pipeline.test.ts
 *
 * End-to-end integration tests that validate all modules compose correctly.
 *
 * No real API calls are made — all Gmail and Sheets interactions are mocked
 * at the GmailClient / SheetsClient interface level. Temp directories are
 * used for checkpoint/batch files and cleaned up in afterAll.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scoreAll } from "../../src/analysis/confidence-scorer.js";

// Analysis
import { analyzeSenders } from "../../src/analysis/sender-analyzer.js";
// Types
import type { GmailClient, Result } from "../../src/auth/gmail-client.js";
import type { SheetsClient } from "../../src/auth/sheets-client.js";
import { applyClassifications, ensureLabelsExist } from "../../src/classify/label-applier.js";
import type { ClassificationProvider } from "../../src/classify/llm-classifier.js";
import { classifyBatch } from "../../src/classify/llm-classifier.js";
import { classify, loadRules } from "../../src/classify/rule-engine.js";
import type { ThreadSummary } from "../../src/classify/thread-collapser.js";
// Classify
import { collapseThreads } from "../../src/classify/thread-collapser.js";
import { batchCreateFilters, ensureNoiseLabel } from "../../src/noise/filter-creator.js";
import { archiveNoiseSenders } from "../../src/noise/noise-remover.js";
// Noise
import { readDecisions } from "../../src/noise/sheets-reader.js";
import { loadAllBatches } from "../../src/pull/checkpoint-manager.js";
// Pull
import { pull } from "../../src/pull/metadata-puller.js";
// Review
import { buildActionReport, finalizeReview } from "../../src/review/action-pass.js";
import type { ThreadClassification } from "../../src/schemas/classification.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Sender definitions for the 50-message corpus
// ---------------------------------------------------------------------------

/**
 * Newsletter/promo senders — should score as definitely_noise.
 * Using noreply/notifications local-parts and marketing infra domains so the
 * hard-override rules in confidence-scorer.ts fire reliably.
 */
const NEWSLETTER_SENDERS = [
  { email: "noreply@morning-brew.com", name: "Morning Brew", category: "promotions" as const },
  { email: "newsletter@r.mailchimp.com", name: "RetailMeNot", category: "promotions" as const },
  { email: "notifications@sendgrid.net", name: "Substack Digest", category: "promotions" as const },
] as const;

/** Social notification senders — should score as probably_noise or definitely_noise */
const SOCIAL_SENDERS = [
  { email: "notifications-noreply@linkedin.com", name: "LinkedIn", category: "social" as const },
  { email: "notification@twitter.com", name: "Twitter", category: "social" as const },
] as const;

/** Real human senders — should score as probably_keep or definitely_keep */
const HUMAN_SENDERS = [
  { email: "sarah.johnson@gmail.com", name: "Sarah Johnson", category: "primary" as const },
  { email: "mike.chen@company.com", name: "Mike Chen", category: "primary" as const },
  { email: "alice.smith@university.edu", name: "Alice Smith", category: "primary" as const },
  { email: "bob.wilson@startup.io", name: "Bob Wilson", category: "primary" as const },
  { email: "carol.jones@agency.net", name: "Carol Jones", category: "primary" as const },
] as const;

// ---------------------------------------------------------------------------
// Build the 50-message corpus
// ---------------------------------------------------------------------------

/** Recent date factory (within 90 days to ensure "recent" recency signal). */
function recentDate(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

/**
 * Builds the 50-message corpus:
 * - 3 newsletters × 8 emails each = 24
 * - 2 social × 4 emails each     = 8
 * - 5 humans × (3–4) emails each = ~18 (total 50 with padding)
 */
function buildCorpus(): EmailMetadata[] {
  const corpus: EmailMetadata[] = [];
  let msgIndex = 0;

  function makeMsg(
    sender: {
      email: string;
      name: string;
      category: "promotions" | "social" | "primary" | "updates" | "forums" | "unknown";
    },
    threadSuffix: string,
    daysAgo: number,
    isUnread: boolean,
    labels: string[],
  ): EmailMetadata {
    msgIndex++;
    return {
      messageId: `msg-${String(msgIndex).padStart(3, "0")}`,
      threadId: `thread-${threadSuffix}`,
      sender: { email: sender.email, name: sender.name },
      recipients: { to: ["me@example.com"], cc: [] },
      subject: `Email from ${sender.name} #${msgIndex}`,
      dateReceived: recentDate(daysAgo),
      gmailCategory: sender.category,
      labels,
      isUnread,
      snippet: `Snippet for message ${msgIndex}`,
    };
  }

  // Newsletter senders: 8 emails each, all unread, promotions category
  for (const sender of NEWSLETTER_SENDERS) {
    for (let i = 0; i < 8; i++) {
      corpus.push(
        makeMsg(
          sender,
          `${sender.email.split("@")[0]!}-${i}`,
          i * 3 + 1,
          true, // high unread ratio → noise signal
          ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        ),
      );
    }
  }

  // Social senders: 4 emails each, unread, social category
  for (const sender of SOCIAL_SENDERS) {
    for (let i = 0; i < 4; i++) {
      corpus.push(
        makeMsg(
          sender,
          `${sender.email.split("@")[0]!}-${i}`,
          i * 5 + 2,
          true, // unread
          ["INBOX", "UNREAD", "CATEGORY_SOCIAL"],
        ),
      );
    }
  }

  // Human senders: 3–4 emails each, mix of read/unread, primary category
  const humanCounts = [4, 3, 4, 3, 4]; // totals to 18 → corpus = 24+8+18 = 50
  for (let h = 0; h < HUMAN_SENDERS.length; h++) {
    const sender = HUMAN_SENDERS[h]!;
    const count = humanCounts[h]!;
    for (let i = 0; i < count; i++) {
      corpus.push(
        makeMsg(
          sender,
          `${sender.email.split("@")[0]!}-${i}`,
          i * 7 + 3,
          i === 0, // only first message unread (low unread ratio → keep signal)
          ["INBOX"],
        ),
      );
    }
  }

  return corpus;
}

const CORPUS = buildCorpus();

// ---------------------------------------------------------------------------
// Mock GmailClient factory
// ---------------------------------------------------------------------------

/** Creates a mock GmailClient backed by a lookup map of raw messages. */
function createMockGmailClient(messageMap: Map<string, gmail_v1.Schema$Message>): GmailClient & {
  _batchModifyCalls: Array<{ ids: string[]; add?: string[]; remove?: string[] }>;
  _createdLabels: string[];
  _createdFilters: Array<{ from: string }>;
} {
  const batchModifyCalls: Array<{ ids: string[]; add?: string[]; remove?: string[] }> = [];
  const createdLabels: Array<{ name: string; id: string }> = [
    { name: "INBOX", id: "INBOX" },
    { name: "UNREAD", id: "UNREAD" },
  ];
  const createdFilters: Array<{ from: string }> = [];

  return {
    _batchModifyCalls: batchModifyCalls,
    _createdLabels: createdLabels.map((l) => l.name),
    _createdFilters: createdFilters,

    getProfile: vi
      .fn<() => Promise<Result<{ emailAddress: string; messagesTotal: number }>>>()
      .mockResolvedValue({ ok: true, value: { emailAddress: "me@example.com", messagesTotal: 50 } }),

    listMessages: vi
      .fn<
        (
          query: string,
        ) => Promise<Result<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>>
      >()
      .mockImplementation(async (query: string) => {
        // Filter messages based on query
        const allIds = Array.from(messageMap.keys());
        let filteredIds = allIds;

        // Handle "from:sender" queries for noise-remover
        const fromMatch = /^from:(.+)$/.exec(query);
        if (fromMatch !== null && fromMatch[1] !== undefined) {
          const targetSender = fromMatch[1].trim().toLowerCase();
          filteredIds = allIds.filter((id) => {
            const msg = messageMap.get(id);
            if (msg === undefined) return false;
            const fromHeader = msg.payload?.headers?.find((h) => h.name === "From");
            const fromVal = (fromHeader?.value ?? "").toLowerCase();
            return fromVal.includes(targetSender);
          });
        }

        // Handle "label:_triage" queries for action-pass
        if (query === "label:_triage") {
          const triageLabelId = createdLabels.find((label) => label.name === "_triage")?.id ?? "_triage";
          filteredIds = allIds.filter((id) => {
            const msg = messageMap.get(id);
            return msg?.labelIds?.includes(triageLabelId) === true || msg?.labelIds?.includes("_triage") === true;
          });
        }

        // For the pull query, return all messages in chunks
        const messages = filteredIds.map((id) => ({
          id,
          threadId: messageMap.get(id)?.threadId ?? id,
        }));

        return {
          ok: true,
          value: { messages, nextPageToken: undefined },
        };
      }),

    getMessage: vi
      .fn<(id: string) => Promise<Result<gmail_v1.Schema$Message>>>()
      .mockImplementation(async (id: string) => {
        const msg = messageMap.get(id);
        if (msg === undefined) {
          return { ok: false, error: `Message ${id} not found` };
        }
        return { ok: true, value: msg };
      }),

    batchModifyMessages: vi
      .fn<(ids: string[], add?: string[], remove?: string[]) => Promise<Result<void>>>()
      .mockImplementation(async (ids, add, remove) => {
        batchModifyCalls.push({ ids, add, remove });
        // Apply label changes to in-memory messages
        for (const id of ids) {
          const msg = messageMap.get(id);
          if (msg === undefined) continue;
          const currentLabels = msg.labelIds ?? [];
          const afterRemove = remove === undefined ? currentLabels : currentLabels.filter((l) => !remove.includes(l));
          const afterAdd =
            add === undefined ? afterRemove : [...afterRemove, ...add.filter((l) => !afterRemove.includes(l))];
          messageMap.set(id, { ...msg, labelIds: afterAdd });
        }
        return { ok: true, value: undefined };
      }),

    listLabels: vi.fn<() => Promise<Result<gmail_v1.Schema$Label[]>>>().mockImplementation(async () => {
      return {
        ok: true,
        value: createdLabels.map((l) => ({ id: l.id, name: l.name })),
      };
    }),

    listFilters: vi.fn<() => Promise<Result<gmail_v1.Schema$Filter[]>>>().mockResolvedValue({ ok: true, value: [] }),

    createLabel: vi
      .fn<(name: string) => Promise<Result<gmail_v1.Schema$Label>>>()
      .mockImplementation(async (name: string) => {
        const existing = createdLabels.find((l) => l.name === name);
        if (existing !== undefined) {
          return { ok: true, value: { id: existing.id, name } };
        }
        const id = `lbl-${name.replace(/[^a-zA-Z0-9]/g, "-")}`;
        createdLabels.push({ name, id });
        return { ok: true, value: { id, name } };
      }),

    createFilter: vi
      .fn<(criteria: { from?: string }, action: unknown) => Promise<Result<gmail_v1.Schema$Filter>>>()
      .mockImplementation(async (criteria) => {
        if (criteria.from !== undefined) {
          createdFilters.push({ from: criteria.from });
        }
        return {
          ok: true,
          value: { id: `filter-${createdFilters.length}`, criteria, action: {} },
        };
      }),
  };
}

/** Converts an EmailMetadata corpus to a Map<messageId, gmail_v1.Schema$Message>. */
function corpusToMessageMap(corpus: EmailMetadata[]): Map<string, gmail_v1.Schema$Message> {
  const map = new Map<string, gmail_v1.Schema$Message>();
  for (const email of corpus) {
    map.set(email.messageId, {
      id: email.messageId,
      threadId: email.threadId,
      labelIds: [...email.labels],
      snippet: email.snippet,
      internalDate: String(email.dateReceived.getTime()),
      payload: {
        headers: [
          { name: "From", value: `${email.sender.name} <${email.sender.email}>` },
          { name: "To", value: email.recipients.to[0] ?? "me@example.com" },
          { name: "Subject", value: email.subject },
          { name: "Date", value: email.dateReceived.toUTCString() },
        ],
      },
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Mock SheetsClient factory
// ---------------------------------------------------------------------------

function createMockSheetsClient(decisionRows: unknown[][]): SheetsClient {
  return {
    createSpreadsheet: vi
      .fn<() => Promise<Result<{ spreadsheetId: string; spreadsheetUrl: string }>>>()
      .mockResolvedValue({
        ok: true,
        value: { spreadsheetId: "sheet-001", spreadsheetUrl: "https://sheets.google.com/sheet-001" },
      }),

    writeRows: vi.fn<() => Promise<Result<void>>>().mockResolvedValue({ ok: true, value: undefined }),

    readRows: vi.fn<() => Promise<Result<unknown[][]>>>().mockResolvedValue({ ok: true, value: decisionRows }),

    formatSheet: vi.fn<() => Promise<Result<void>>>().mockResolvedValue({ ok: true, value: undefined }),
  };
}

// ---------------------------------------------------------------------------
// Mock ClassificationProvider
// ---------------------------------------------------------------------------

/** Returns realistic classifications for threads based on sender patterns. */
function createMockLLMProvider(threadMap: Map<string, ThreadSummary>): ClassificationProvider {
  return {
    classify: vi
      .fn<(content: string, categories: string[], threadId: string) => Promise<Result<ThreadClassification>>>()
      .mockImplementation(
        async (_content: string, _categories: string[], threadId: string): Promise<Result<ThreadClassification>> => {
          const thread = threadMap.get(threadId);
          if (thread === undefined) {
            return {
              ok: true,
              value: {
                threadId,
                category: "uncategorized",
                confidence: 0.5,
                actionable: false,
                summary: "Unknown thread.",
                classifiedBy: "llm",
              },
            };
          }

          const senderEmail = thread.senderEmail.toLowerCase();

          // Human senders get actionable personal category
          if (
            senderEmail.includes("gmail.com") ||
            senderEmail.includes("company.com") ||
            senderEmail.includes("university.edu") ||
            senderEmail.includes("startup.io") ||
            senderEmail.includes("agency.net")
          ) {
            return {
              ok: true,
              value: {
                threadId,
                category: "personal",
                confidence: 0.92,
                actionable: true,
                summary: "Personal email from a known contact requiring a response.",
                classifiedBy: "llm",
              },
            };
          }

          return {
            ok: true,
            value: {
              threadId,
              category: "transactional",
              confidence: 0.75,
              actionable: false,
              summary: "Automated transactional email.",
              classifiedBy: "llm",
            },
          };
        },
      ),

    proposeTaxonomy: vi.fn<() => Promise<Result<string[]>>>().mockResolvedValue({
      ok: true,
      value: ["newsletter", "transactional", "personal", "social"],
    }),
  };
}

// ---------------------------------------------------------------------------
// Module-level state for the mega integration test
// ---------------------------------------------------------------------------

let tmpDir: string;

afterAll(async () => {
  if (tmpDir !== undefined) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// MEGA INTEGRATION TEST — Full pipeline
// ===========================================================================

describe("Full pipeline integration test", () => {
  it("runs the complete pipeline from pull through review without errors", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-zero-integration-"));
    const dataDir = path.join(tmpDir, "data");
    const reportsDir = path.join(tmpDir, "reports");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(reportsDir, { recursive: true });

    // -----------------------------------------------------------------------
    // Build mocks
    // -----------------------------------------------------------------------

    const messageMap = corpusToMessageMap(CORPUS);
    const gmailClient = createMockGmailClient(messageMap);

    // Build Sheets decision rows (header + 10 data rows)
    // 3 unsubscribe (newsletters), 2 filter (social), 5 keep (humans)
    const HEADER_ROW = [
      "Sender email",
      "Sender name",
      "Email count",
      "First email date",
      "Last email date",
      "Gmail category",
      "Unread ratio",
      "Thread count",
      "Sample subjects",
      "Confidence tier",
      "Recommended action",
      "Surprises flag",
      "Your decision",
    ];
    const decisionRows: unknown[][] = [
      HEADER_ROW,
      ...NEWSLETTER_SENDERS.map((s) => {
        const row: unknown[] = new Array(13).fill("");
        row[0] = s.email;
        row[12] = "unsubscribe";
        return row;
      }),
      ...SOCIAL_SENDERS.map((s) => {
        const row: unknown[] = new Array(13).fill("");
        row[0] = s.email;
        row[12] = "filter";
        return row;
      }),
      ...HUMAN_SENDERS.map((s) => {
        const row: unknown[] = new Array(13).fill("");
        row[0] = s.email;
        row[12] = "keep";
        return row;
      }),
    ];
    const sheetsClient = createMockSheetsClient(decisionRows);

    // -----------------------------------------------------------------------
    // STEP 1: Pull metadata
    // -----------------------------------------------------------------------

    const pullResult = await pull({
      client: gmailClient,
      dataDir,
    });

    expect(pullResult.ok).toBe(true);
    if (!pullResult.ok) throw new Error(`Pull failed: ${pullResult.error}`);

    expect(pullResult.value.messagesFetched).toBe(50);
    expect(pullResult.value.errors).toHaveLength(0);

    // -----------------------------------------------------------------------
    // STEP 2: Load batches and run analysis
    // -----------------------------------------------------------------------

    const batchesResult = await loadAllBatches(dataDir);
    expect(batchesResult.ok).toBe(true);
    if (!batchesResult.ok) throw new Error(`loadAllBatches failed: ${batchesResult.error}`);

    const emails = batchesResult.value;
    expect(emails).toHaveLength(50);

    // Sender analysis
    const senderStats = analyzeSenders(emails);
    expect(senderStats).toHaveLength(10); // 10 unique senders

    // Confidence scoring
    const scoredStats = scoreAll(senderStats);
    expect(scoredStats).toHaveLength(10);

    // Verify newsletter senders score as definitely_noise
    for (const sender of NEWSLETTER_SENDERS) {
      const stat = scoredStats.find((s) => s.senderEmail === sender.email);
      expect(stat, `Missing stat for ${sender.email}`).toBeDefined();
      expect(stat!.confidenceTier).toBe("definitely_noise");
    }

    // Verify human senders score as probably_keep or definitely_keep
    for (const sender of HUMAN_SENDERS) {
      const stat = scoredStats.find((s) => s.senderEmail === sender.email);
      expect(stat, `Missing stat for ${sender.email}`).toBeDefined();
      const tier = stat!.confidenceTier;
      expect(
        tier === "probably_keep" || tier === "definitely_keep",
        `Expected ${sender.email} to be probably_keep or definitely_keep, got ${String(tier)}`,
      ).toBe(true);
    }

    // -----------------------------------------------------------------------
    // STEP 3: Read user decisions from Sheets
    // -----------------------------------------------------------------------

    const decisionsResult = await readDecisions(sheetsClient, "sheet-001");
    expect(decisionsResult.ok).toBe(true);
    if (!decisionsResult.ok) throw new Error(`readDecisions failed: ${decisionsResult.error}`);

    const decisions = decisionsResult.value;
    expect(decisions.size).toBe(10);

    // Verify decision types
    for (const sender of NEWSLETTER_SENDERS) {
      expect(decisions.get(sender.email)).toBe("unsubscribe");
    }
    for (const sender of SOCIAL_SENDERS) {
      expect(decisions.get(sender.email)).toBe("filter");
    }
    for (const sender of HUMAN_SENDERS) {
      expect(decisions.get(sender.email)).toBe("keep");
    }

    // -----------------------------------------------------------------------
    // STEP 4: Clean — create _noise label, filters, archive noise emails
    // -----------------------------------------------------------------------

    // Ensure _noise label exists
    const noiseLabelResult = await ensureNoiseLabel(gmailClient);
    expect(noiseLabelResult.ok).toBe(true);
    if (!noiseLabelResult.ok) throw new Error(`ensureNoiseLabel failed: ${noiseLabelResult.error}`);

    const noiseLabelId = noiseLabelResult.value;
    expect(noiseLabelId).toBeTruthy();

    // Build filter map for noise senders (unsubscribe + filter decisions)
    const filterMap = new Map<string, "filter" | "unsubscribe">();
    for (const [sender, decision] of decisions) {
      if (decision === "filter" || decision === "unsubscribe") {
        filterMap.set(sender, decision);
      }
    }
    expect(filterMap.size).toBe(5); // 3 unsubscribe + 2 filter

    // Create filters
    const filterResult = await batchCreateFilters(gmailClient, filterMap);
    expect(filterResult.created).toBe(5);
    expect(filterResult.failures).toHaveLength(0);

    // Verify correct filter criteria (from: each noise sender)
    const filterFromSet = new Set(
      (gmailClient as ReturnType<typeof createMockGmailClient>)._createdFilters.map((f) => f.from),
    );
    for (const sender of NEWSLETTER_SENDERS) {
      expect(filterFromSet.has(sender.email), `Missing filter for ${sender.email}`).toBe(true);
    }
    for (const sender of SOCIAL_SENDERS) {
      expect(filterFromSet.has(sender.email), `Missing filter for ${sender.email}`).toBe(true);
    }

    // Archive noise emails
    const noiseSenders = Array.from(filterMap.keys());
    const archiveResult = await archiveNoiseSenders(gmailClient, noiseSenders, noiseLabelId);
    expect(archiveResult.failures).toHaveLength(0);
    expect(archiveResult.totalArchived).toBeGreaterThan(0);

    // Verify batch modify was called for noise archiving
    const batchModifyCalls = (gmailClient as ReturnType<typeof createMockGmailClient>)._batchModifyCalls;
    const archiveCalls = batchModifyCalls.filter(
      (c) => c.remove?.includes("INBOX") === true && c.add?.includes(noiseLabelId) === true,
    );
    expect(archiveCalls.length).toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // STEP 5: Classify remaining (non-noise) emails
    // -----------------------------------------------------------------------

    // Get human emails only
    const humanEmails = emails.filter((e) => HUMAN_SENDERS.some((s) => s.email === e.sender.email));
    expect(humanEmails.length).toBeGreaterThan(0);

    // Collapse into threads
    const bodyMap = new Map<string, string>();
    for (const email of humanEmails) {
      bodyMap.set(email.messageId, `Body of ${email.subject}`);
    }
    const threads = collapseThreads(humanEmails, bodyMap);
    expect(threads.length).toBeGreaterThan(0);

    // Write rules config for 2 known domain threads
    const rulesConfigPath = path.join(tmpDir, "rules.json");
    // alice.smith@university.edu and bob.wilson@startup.io get domain rules
    const rulesConfig = {
      domainRules: {
        "university.edu": "academic",
        "startup.io": "startup",
      },
      senderRules: {} as Record<string, string | null>,
    };
    await fs.writeFile(rulesConfigPath, JSON.stringify(rulesConfig, null, 2), "utf8");

    // Load rules
    const rulesResult = loadRules(rulesConfigPath);
    expect(rulesResult.ok).toBe(true);
    if (!rulesResult.ok) throw new Error(`loadRules failed: ${rulesResult.error}`);

    const rules = rulesResult.value;

    // Apply rule engine — handle threads with domain rules
    const ruleMatched: ThreadClassification[] = [];
    const llmPending: ThreadSummary[] = [];

    for (const thread of threads) {
      const ruleResult = classify(thread, rules);
      if (ruleResult !== null) {
        ruleMatched.push(ruleResult);
      } else {
        llmPending.push(thread);
      }
    }

    // At least 2 threads should match domain rules (university.edu + startup.io)
    const academicMatches = ruleMatched.filter((c) => c.category === "academic");
    const startupMatches = ruleMatched.filter((c) => c.category === "startup");
    expect(academicMatches.length).toBeGreaterThanOrEqual(1);
    expect(startupMatches.length).toBeGreaterThanOrEqual(1);

    // Rule-matched threads are classified by "rule"
    for (const classification of ruleMatched) {
      expect(classification.classifiedBy).toBe("rule");
    }

    // LLM handles remaining threads
    const threadSummaryMap = new Map<string, ThreadSummary>();
    for (const thread of threads) {
      threadSummaryMap.set(thread.threadId, thread);
    }
    const mockProvider = createMockLLMProvider(threadSummaryMap);

    const llmResults = await classifyBatch(llmPending, mockProvider, ["newsletter", "transactional", "personal"]);
    expect(llmResults).toHaveLength(llmPending.length);

    // Human sender threads classified by LLM should be "personal"
    for (const result of llmResults) {
      expect(result.classifiedBy).toBe("llm");
      expect(result.category).toBe("personal");
    }

    // -----------------------------------------------------------------------
    // STEP 6: Apply labels to classified threads
    // -----------------------------------------------------------------------

    const allClassifications = [...ruleMatched, ...llmResults];

    // Build threadId → messageIds map
    const threadToMessages = new Map<string, string[]>();
    for (const email of humanEmails) {
      const existing = threadToMessages.get(email.threadId) ?? [];
      existing.push(email.messageId);
      threadToMessages.set(email.threadId, existing);
    }

    // Get unique categories
    const categories = [...new Set(allClassifications.map((c) => c.category))];

    // Ensure labels exist
    const labelMapResult = await ensureLabelsExist(categories, gmailClient);
    expect(labelMapResult.ok).toBe(true);
    if (!labelMapResult.ok) throw new Error(`ensureLabelsExist failed: ${labelMapResult.error}`);

    const labelMap = labelMapResult.value;
    expect(labelMap.size).toBeGreaterThanOrEqual(categories.length);

    // Apply classifications
    const applySummary = await applyClassifications(allClassifications, threadToMessages, labelMap, gmailClient);
    expect(applySummary.ok).toBe(true);
    if (!applySummary.ok) throw new Error(`applyClassifications failed: ${applySummary.error}`);

    const applyValue = applySummary.value;
    expect(applyValue.failures).toHaveLength(0);
    expect(applyValue.totalApplied).toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // STEP 7: Tag triage items in messageMap for the review pass
    // -----------------------------------------------------------------------

    // Manually tag 2 actionable messages with _triage label for review test
    const triageMessageIds = ["msg-001", "msg-002"];
    const triageLabelResult = await gmailClient.createLabel("_triage");
    expect(triageLabelResult.ok).toBe(true);
    if (!triageLabelResult.ok) throw new Error("createLabel _triage failed");

    const triageLabelId = triageLabelResult.value.id!;
    const personalLabelResult = await gmailClient.createLabel("personal");
    expect(personalLabelResult.ok).toBe(true);
    if (!personalLabelResult.ok) throw new Error("createLabel personal failed");
    const personalLabelId = personalLabelResult.value.id!;

    for (const id of triageMessageIds) {
      const msg = messageMap.get(id);
      if (msg !== undefined) {
        messageMap.set(id, {
          ...msg,
          labelIds: [...(msg.labelIds ?? []), triageLabelId, personalLabelId],
        });
      }
    }

    // -----------------------------------------------------------------------
    // STEP 8: Review — buildActionReport finds triage items
    // -----------------------------------------------------------------------

    const reportResult = await buildActionReport(gmailClient, reportsDir);
    expect(reportResult.ok).toBe(true);
    if (!reportResult.ok) throw new Error(`buildActionReport failed: ${reportResult.error}`);

    expect(reportResult.value.itemCount).toBeGreaterThanOrEqual(2);

    // Verify report file was written
    const reportContent = await fs.readFile(reportResult.value.reportPath, "utf8");
    expect(reportContent).toContain("Action Pass Report");

    // -----------------------------------------------------------------------
    // STEP 9: finalizeReview — star 1, archive 1
    // -----------------------------------------------------------------------

    const reviewDecisions = new Map<string, "star" | "archive">([
      [triageMessageIds[0]!, "star"],
      [triageMessageIds[1]!, "archive"],
    ]);

    const finalizeResult = await finalizeReview(reviewDecisions, triageLabelId, gmailClient);
    expect(finalizeResult.ok).toBe(true);
    if (!finalizeResult.ok) throw new Error(`finalizeReview failed: ${finalizeResult.error}`);

    expect(finalizeResult.value.starred).toBe(1);
    expect(finalizeResult.value.archived).toBe(1);

    // Verify starred message has STARRED label
    const starredMsg = messageMap.get(triageMessageIds[0]!);
    expect(starredMsg?.labelIds).toBeDefined();
    expect(starredMsg!.labelIds!.includes("STARRED")).toBe(true);
    expect(starredMsg!.labelIds!.includes(triageLabelId)).toBe(false);

    // Verify archived message has INBOX removed
    const archivedMsg = messageMap.get(triageMessageIds[1]!);
    expect(archivedMsg?.labelIds).toBeDefined();
    expect(archivedMsg!.labelIds!.includes("INBOX")).toBe(false);
    expect(archivedMsg!.labelIds!.includes(triageLabelId)).toBe(false);

    // -----------------------------------------------------------------------
    // FINAL STATE VERIFICATION
    // -----------------------------------------------------------------------

    // 1. Noise emails archived: messages from noise senders should have _noise label
    let noiseArchivedCount = 0;
    for (const email of CORPUS) {
      const isNoiseSender =
        NEWSLETTER_SENDERS.some((s) => s.email === email.sender.email) ||
        SOCIAL_SENDERS.some((s) => s.email === email.sender.email);
      if (isNoiseSender) {
        const msg = messageMap.get(email.messageId);
        if (msg?.labelIds?.includes(noiseLabelId) === true) {
          noiseArchivedCount++;
        }
      }
    }
    expect(noiseArchivedCount).toBeGreaterThan(0);

    // 2. All batch modify calls went to real message IDs
    for (const call of batchModifyCalls) {
      for (const id of call.ids) {
        expect(messageMap.has(id), `batchModify called with unknown id: ${id}`).toBe(true);
      }
    }

    // 3. _triage cleared from reviewed messages
    const triageRemainingInMsg0 = messageMap.get(triageMessageIds[0]!)?.labelIds?.includes(triageLabelId) ?? false;
    const triageRemainingInMsg1 = messageMap.get(triageMessageIds[1]!)?.labelIds?.includes(triageLabelId) ?? false;
    expect(triageRemainingInMsg0).toBe(false);
    expect(triageRemainingInMsg1).toBe(false);
  });
});

// ===========================================================================
// SMALLER INTEGRATION TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// Pull → Analyze pipeline produces correct Sheets output shape
// ---------------------------------------------------------------------------

describe("Pull → Analyze pipeline", () => {
  it("produces correct Sheets output shape after pull and analyze", async () => {
    const localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-zero-pull-analyze-"));

    try {
      const dataDir = path.join(localTmpDir, "data");
      await fs.mkdir(dataDir, { recursive: true });

      const messageMap = corpusToMessageMap(CORPUS);
      const gmailClient = createMockGmailClient(messageMap);

      // Pull
      const pullResult = await pull({ client: gmailClient, dataDir });
      expect(pullResult.ok).toBe(true);
      if (!pullResult.ok) throw new Error(`Pull failed: ${pullResult.error}`);

      // Load and analyze
      const batchesResult = await loadAllBatches(dataDir);
      expect(batchesResult.ok).toBe(true);
      if (!batchesResult.ok) throw new Error("loadAllBatches failed");

      const senderStats = analyzeSenders(batchesResult.value);
      const scoredStats = scoreAll(senderStats);

      // Shape: each stat has required fields
      for (const stat of scoredStats) {
        expect(stat.senderEmail).toBeTruthy();
        expect(stat.emailCount).toBeGreaterThanOrEqual(1);
        expect(typeof stat.unreadRatio).toBe("number");
        expect(stat.gmailCategory).toBeTruthy();
        expect(stat.confidenceTier).toBeDefined();
        expect(stat.recommendedAction).toBeDefined();
        expect(typeof stat.surprisesFlag).toBe("boolean");
      }

      // Stats should be sorted by email count descending
      for (let i = 1; i < scoredStats.length; i++) {
        expect(scoredStats[i - 1]!.emailCount).toBeGreaterThanOrEqual(scoredStats[i]!.emailCount);
      }

      // Newsletter senders (8 emails each) should appear before human senders (3-4 each)
      const newsletterStatIdx = scoredStats.findIndex((s) => s.senderEmail === NEWSLETTER_SENDERS[0]!.email);
      const humanStatIdx = scoredStats.findIndex((s) => s.senderEmail === HUMAN_SENDERS[0]!.email);
      expect(newsletterStatIdx).toBeLessThan(humanStatIdx);
    } finally {
      await fs.rm(localTmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Clean pipeline reads decisions and creates correct number of filters
// ---------------------------------------------------------------------------

describe("Clean pipeline", () => {
  it("reads decisions and creates correct number of filters", async () => {
    // Build decision rows with 4 noise senders (2 unsubscribe + 2 filter)
    const HEADER_ROW = ["Sender email", "", "", "", "", "", "", "", "", "", "", "", "Your decision"];
    const decisionRows: unknown[][] = [
      HEADER_ROW,
      (() => {
        const r: unknown[] = new Array(13).fill("");
        r[0] = "spam1@spammy.com";
        r[12] = "unsubscribe";
        return r;
      })(),
      (() => {
        const r: unknown[] = new Array(13).fill("");
        r[0] = "spam2@spammy.com";
        r[12] = "unsubscribe";
        return r;
      })(),
      (() => {
        const r: unknown[] = new Array(13).fill("");
        r[0] = "noise1@noisy.com";
        r[12] = "filter";
        return r;
      })(),
      (() => {
        const r: unknown[] = new Array(13).fill("");
        r[0] = "noise2@noisy.com";
        r[12] = "filter";
        return r;
      })(),
      (() => {
        const r: unknown[] = new Array(13).fill("");
        r[0] = "human@gmail.com";
        r[12] = "keep";
        return r;
      })(),
    ];

    const sheetsClient = createMockSheetsClient(decisionRows);

    const decisionsResult = await readDecisions(sheetsClient, "test-sheet");
    expect(decisionsResult.ok).toBe(true);
    if (!decisionsResult.ok) throw new Error("readDecisions failed");

    const decisions = decisionsResult.value;

    // Build filter/unsubscribe map
    const filterMap = new Map<string, "filter" | "unsubscribe">();
    for (const [sender, decision] of decisions) {
      if (decision === "filter" || decision === "unsubscribe") {
        filterMap.set(sender, decision);
      }
    }
    expect(filterMap.size).toBe(4);
    expect(filterMap.get("spam1@spammy.com")).toBe("unsubscribe");
    expect(filterMap.get("noise1@noisy.com")).toBe("filter");

    // Apply filters via mock gmail
    const messageMap = new Map<string, gmail_v1.Schema$Message>();
    const gmailClient = createMockGmailClient(messageMap);

    const filterResult = await batchCreateFilters(gmailClient, filterMap);
    expect(filterResult.created).toBe(4);
    expect(filterResult.failures).toHaveLength(0);

    // Verify 4 filters created with correct from: criteria
    const createdFilters = (gmailClient as ReturnType<typeof createMockGmailClient>)._createdFilters;
    expect(createdFilters).toHaveLength(4);

    const filterFroms = new Set(createdFilters.map((f) => f.from));
    expect(filterFroms.has("spam1@spammy.com")).toBe(true);
    expect(filterFroms.has("spam2@spammy.com")).toBe(true);
    expect(filterFroms.has("noise1@noisy.com")).toBe(true);
    expect(filterFroms.has("noise2@noisy.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classify → Label pipeline applies correct labels
// ---------------------------------------------------------------------------

describe("Classify → Label pipeline", () => {
  it("applies correct labels based on rule engine and LLM classifications", async () => {
    // Build a small corpus: 3 threads
    const now = new Date();
    const recentTs = (d: number): Date => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    const threads: ThreadSummary[] = [
      {
        threadId: "t-rule-1",
        senderEmail: "noreply@github.com",
        subject: "PR merged",
        participants: ["noreply@github.com"],
        dateRange: { first: recentTs(5), last: recentTs(1) },
        content: "Your pull request was merged.",
        messageCount: 1,
      },
      {
        threadId: "t-llm-1",
        senderEmail: "friend@gmail.com",
        subject: "Weekend plans?",
        participants: ["friend@gmail.com"],
        dateRange: { first: recentTs(3), last: recentTs(1) },
        content: "Hey, are you free this weekend?",
        messageCount: 2,
      },
      {
        threadId: "t-llm-2",
        senderEmail: "boss@company.com",
        subject: "Project update",
        participants: ["boss@company.com"],
        dateRange: { first: recentTs(2), last: recentTs(1) },
        content: "Please send me the status report by Friday.",
        messageCount: 1,
      },
    ];

    // Rule engine for github.com domain
    const rulesConfig = {
      domainRules: { "github.com": "developer-notifications" },
      senderRules: {} as Record<string, string | null>,
    };

    const ruleMatched: ThreadClassification[] = [];
    const llmPending: ThreadSummary[] = [];

    for (const thread of threads) {
      const result = classify(thread, rulesConfig);
      if (result !== null) {
        ruleMatched.push(result);
      } else {
        llmPending.push(thread);
      }
    }

    expect(ruleMatched).toHaveLength(1);
    expect(ruleMatched[0]!.category).toBe("developer-notifications");
    expect(ruleMatched[0]!.classifiedBy).toBe("rule");
    expect(llmPending).toHaveLength(2);

    // LLM classifies remaining 2
    const threadSummaryMap = new Map(threads.map((t) => [t.threadId, t]));
    const mockProvider = createMockLLMProvider(threadSummaryMap);

    const llmResults = await classifyBatch(llmPending, mockProvider, ["developer-notifications", "personal"]);
    expect(llmResults).toHaveLength(2);
    for (const r of llmResults) {
      expect(r.classifiedBy).toBe("llm");
      expect(r.category).toBe("personal"); // both are personal contacts
    }

    // Apply labels via mock gmail
    const messageMap = new Map<string, gmail_v1.Schema$Message>();
    // Each thread has 1 message
    for (const thread of threads) {
      const msgId = `msg-${thread.threadId}`;
      messageMap.set(msgId, {
        id: msgId,
        threadId: thread.threadId,
        labelIds: ["INBOX"],
        snippet: "",
        internalDate: String(Date.now()),
        payload: { headers: [] },
      });
    }

    const threadToMessages = new Map<string, string[]>();
    for (const thread of threads) {
      threadToMessages.set(thread.threadId, [`msg-${thread.threadId}`]);
    }

    const gmailClient = createMockGmailClient(messageMap);
    const allClassifications = [...ruleMatched, ...llmResults];
    const categories = [...new Set(allClassifications.map((c) => c.category))];

    const labelMapResult = await ensureLabelsExist(categories, gmailClient);
    expect(labelMapResult.ok).toBe(true);
    if (!labelMapResult.ok) throw new Error("ensureLabelsExist failed");

    const labelMap = labelMapResult.value;

    const applySummary = await applyClassifications(allClassifications, threadToMessages, labelMap, gmailClient);
    expect(applySummary.ok).toBe(true);
    if (!applySummary.ok) throw new Error("applyClassifications failed");

    expect(applySummary.value.failures).toHaveLength(0);
    expect(applySummary.value.totalApplied).toBeGreaterThan(0);

    // Rule-matched thread (developer-notifications) should be archived (non-actionable by rule)
    // LLM threads (personal) are actionable → _triage
    expect(applySummary.value.totalTriaged).toBeGreaterThan(0);
  });
});
