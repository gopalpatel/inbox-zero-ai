/**
 * action-pass.test.ts
 *
 * Tests for the action-pass review workflow module.
 * All GmailClient interactions and fs I/O are mocked.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result } from "../../src/auth/gmail-client.js";
import { buildActionReport, finalizeReview, TRIAGE_QUERY } from "../../src/review/action-pass.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a mock GmailClient with vi.fn() stubs. */
function createMockClient(): GmailClient {
  return {
    getProfile: vi.fn(),
    listMessages: vi
      .fn<() => Promise<Result<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>>>()
      .mockResolvedValue({
        ok: true,
        value: {
          messages: [
            { id: "msg-1", threadId: "thread-msg-1" },
            { id: "msg-2", threadId: "thread-msg-2" },
            { id: "msg-3", threadId: "thread-msg-3" },
            { id: "msg-4", threadId: "thread-msg-4" },
          ],
        },
      }),
    getMessage: vi
      .fn<() => Promise<Result<gmail_v1.Schema$Message>>>()
      .mockResolvedValue({ ok: true, value: { id: "msg-1", labelIds: [], payload: { headers: [] } } }),
    batchModifyMessages: vi.fn<() => Promise<Result<void>>>().mockResolvedValue({ ok: true, value: undefined }),
    listLabels: vi.fn().mockResolvedValue({
      ok: true,
      value: [
        { id: "label-triage", name: "_triage" },
        { id: "label-newsletters", name: "newsletters" },
        { id: "label-transactional", name: "transactional" },
        { id: "INBOX", name: "INBOX" },
        { id: "STARRED", name: "STARRED" },
      ],
    }),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
  };
}

/**
 * Builds a gmail_v1.Schema$Message with the given headers and label IDs.
 */
function makeMessage(
  id: string,
  headers: Array<{ name: string; value: string }>,
  labelIds: string[],
  internalDate?: string,
  threadId?: string,
): gmail_v1.Schema$Message {
  return {
    id,
    threadId: threadId ?? `thread-${id}`,
    labelIds,
    internalDate: internalDate ?? String(Date.now()),
    payload: {
      headers,
    },
  };
}

function makeMessageStubs(start: number, count: number): Array<{ id: string; threadId: string }> {
  return Array.from({ length: count }, (_, index) => {
    const id = `msg-${start + index}`;
    return {
      id,
      threadId: `thread-${id}`,
    };
  });
}

// ---------------------------------------------------------------------------
// buildActionReport
// ---------------------------------------------------------------------------

describe("buildActionReport", () => {
  let client: GmailClient;
  let tmpDir: string;

  beforeEach(async () => {
    client = createMockClient();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-zero-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("queries Gmail with label:_triage", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({ ok: true, value: { messages: [] } });

    await buildActionReport(client, tmpDir);

    expect(listMessagesMock).toHaveBeenCalledWith(TRIAGE_QUERY, undefined, expect.any(Number));
  });

  it("returns itemCount 0 and produces empty-queue report when _triage is empty", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({ ok: true, value: { messages: [] } });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.itemCount).toBe(0);

    const content = await fs.readFile(result.value.reportPath, "utf8");
    expect(content).toMatch(/No actionable items to review/i);
  });

  it("report filename is action-pass-YYYY-MM-DD.md in reportsDir", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({ ok: true, value: { messages: [] } });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const fileName = path.basename(result.value.reportPath);
    expect(fileName).toMatch(/^action-pass-\d{4}-\d{2}-\d{2}\.md$/);
    expect(path.dirname(result.value.reportPath)).toBe(tmpDir);
  });

  it("fetches full metadata for each triage message", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
        ],
      },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockImplementation(async (id: string) => ({
      ok: true,
      value: makeMessage(
        id,
        [
          { name: "Subject", value: `Subject for ${id}` },
          { name: "From", value: `sender-${id}@example.com` },
          { name: "Date", value: "Mon, 17 Mar 2026 10:00:00 +0000" },
        ],
        ["label-triage", "label-newsletters"],
      ),
    }));

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(getMessageMock).toHaveBeenCalledWith("msg-1", "metadata", expect.any(Array));
    expect(getMessageMock).toHaveBeenCalledWith("msg-2", "metadata", expect.any(Array));
    expect(result.value.itemCount).toBe(2);
  });

  it("groups messages by category label in the report", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
      },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockImplementation(async (id: string) => {
      const categoryMap: Record<string, string> = {
        "msg-1": "newsletters",
        "msg-2": "newsletters",
        "msg-3": "transactional",
      };
      return {
        ok: true,
        value: makeMessage(
          id,
          [
            { name: "Subject", value: `Subject ${id}` },
            { name: "From", value: `from-${id}@test.com` },
            { name: "Date", value: "Mon, 17 Mar 2026 10:00:00 +0000" },
          ],
          ["label-triage", categoryMap[id] === "transactional" ? "label-transactional" : "label-newsletters"],
        ),
      };
    });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const content = await fs.readFile(result.value.reportPath, "utf8");

    // Should have category headers
    expect(content).toMatch(/newsletters/i);
    expect(content).toMatch(/transactional/i);

    // newsletters section should list 2 emails before transactional section
    const newsletterIdx = content.indexOf("newsletters");
    const transactionalIdx = content.indexOf("transactional");
    expect(newsletterIdx).toBeLessThan(transactionalIdx);
  });

  it("each email entry includes sender, subject, and date", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: { messages: [{ id: "msg-1", threadId: "t-1" }] },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockResolvedValue({
      ok: true,
      value: makeMessage(
        "msg-1",
        [
          { name: "Subject", value: "Test Newsletter Subject" },
          { name: "From", value: "newsletter@weekly.com" },
          { name: "Date", value: "Mon, 17 Mar 2026 10:00:00 +0000" },
        ],
        ["label-triage", "label-newsletters"],
      ),
    });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const content = await fs.readFile(result.value.reportPath, "utf8");
    expect(content).toContain("Test Newsletter Subject");
    expect(content).toContain("newsletter@weekly.com");
    expect(content).toContain("2026");
  });

  it("returns error when listMessages fails", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({ ok: false, error: "Gmail API unavailable" });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Gmail API unavailable/);
  });

  it("returns error when listLabels throws", async () => {
    const listLabelsMock = client.listLabels as ReturnType<typeof vi.fn>;
    listLabelsMock.mockRejectedValue(new Error("labels exploded"));

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/listLabels threw/i);
    expect(result.error).toMatch(/labels exploded/);
  });

  it("returns error when a triage thread's representative message cannot be fetched", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: {
        messages: [
          { id: "msg-ok", threadId: "t-1" },
          { id: "msg-fail", threadId: "t-2" },
        ],
      },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockImplementation(async (id: string) => {
      if (id === "msg-fail") {
        return { ok: false, error: "fetch failed" };
      }
      return {
        ok: true,
        value: makeMessage(
          id,
          [
            { name: "Subject", value: "Good Subject" },
            { name: "From", value: "good@example.com" },
            { name: "Date", value: "Mon, 17 Mar 2026 10:00:00 +0000" },
          ],
          ["label-triage", "label-newsletters"],
        ),
      };
    });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Failed to fetch metadata for 1 triage thread/);
    expect(result.error).toMatch(/msg-fail/);
  });

  it("returns error when getMessage throws", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: {
        messages: [{ id: "msg-throw", threadId: "t-throw" }],
      },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockRejectedValue(new Error("boom"));

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Failed to fetch metadata/);
    expect(result.error).toMatch(/getMessage threw: boom/);
  });

  it("writes report to the specified reportsDir", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({ ok: true, value: { messages: [] } });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    // Verify the file actually exists at the returned path
    const stat = await fs.stat(result.value.reportPath);
    expect(stat.isFile()).toBe(true);
  });

  it("collapses multiple triage messages from the same thread into one review item", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock.mockResolvedValue({
      ok: true,
      value: {
        messages: [
          { id: "msg-1", threadId: "thread-shared" },
          { id: "msg-2", threadId: "thread-shared" },
        ],
      },
    });

    const getMessageMock = client.getMessage as ReturnType<typeof vi.fn>;
    getMessageMock.mockResolvedValue({
      ok: true,
      value: makeMessage(
        "msg-1",
        [
          { name: "Subject", value: "Shared thread" },
          { name: "From", value: "shared@example.com" },
          { name: "Date", value: "Mon, 17 Mar 2026 10:00:00 +0000" },
        ],
        ["label-triage", "label-newsletters"],
        undefined,
        "thread-shared",
      ),
    });

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.itemCount).toBe(1);
    expect(getMessageMock).toHaveBeenCalledTimes(1);

    const content = await fs.readFile(result.value.reportPath, "utf8");
    expect(content).toContain("**Messages:** 2");
    expect(content).toContain("thread-shared");
  });

  it("returns error when the triage queue exceeds the safety limit", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;

    // 20 pages of 500 = 10,000 messages, each page has a nextPageToken
    for (let page = 0; page < 20; page++) {
      listMessagesMock.mockResolvedValueOnce({
        ok: true,
        value: {
          messages: makeMessageStubs(page * 500, 500),
          nextPageToken: `page-${page + 2}`,
        },
      });
    }

    const result = await buildActionReport(client, tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/safety limit/i);
    expect(result.error).toMatch(/partial action pass/i);
  });
});

// ---------------------------------------------------------------------------
// finalizeReview
// ---------------------------------------------------------------------------

describe("finalizeReview", () => {
  let client: GmailClient;

  beforeEach(() => {
    client = createMockClient();
  });

  it("stars messages with 'star' decision: adds STARRED, removes triage label", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-1", "star"],
      ["msg-2", "star"],
    ]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).toHaveBeenCalled();

    // Find a call that adds STARRED and removes the triage label
    const calls: Array<[string[], string[] | undefined, string[] | undefined]> = batchModifyMock.mock.calls;
    const starCall = calls.find((c) => {
      const [, addLabels, removeLabels] = c;
      return addLabels?.includes("STARRED") === true && removeLabels?.includes("lbl-triage-id") === true;
    });
    expect(starCall).toBeDefined();
    if (!starCall) throw new Error("Expected star call");
    expect(starCall[0]).toContain("msg-1");
    expect(starCall[0]).toContain("msg-2");
  });

  it("archives messages with 'archive' decision: removes INBOX and triage label", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-3", "archive"],
      ["msg-4", "archive"],
    ]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    const calls: Array<[string[], string[] | undefined, string[] | undefined]> = batchModifyMock.mock.calls;

    const archiveCall = calls.find((c) => {
      const [, , removeLabels] = c;
      return removeLabels?.includes("INBOX") === true && removeLabels?.includes("lbl-triage-id") === true;
    });
    expect(archiveCall).toBeDefined();
    if (!archiveCall) throw new Error("Expected archive call");
    expect(archiveCall[0]).toContain("msg-3");
    expect(archiveCall[0]).toContain("msg-4");
  });

  it("returns { starred, archived } counts", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-1", "star"],
      ["msg-2", "star"],
      ["msg-3", "archive"],
    ]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.starred).toBe(2);
    expect(result.value.archived).toBe(1);
  });

  it("handles empty decisions map without calling Gmail", async () => {
    const decisions = new Map<string, "star" | "archive">();

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.starred).toBe(0);
    expect(result.value.archived).toBe(0);

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).not.toHaveBeenCalled();
  });

  it("dry-run mode reports intended changes without calling Gmail", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-1", "star"],
      ["msg-2", "archive"],
      ["msg-3", "archive"],
    ]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client, { dryRun: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    // Correct counts returned
    expect(result.value.starred).toBe(1);
    expect(result.value.archived).toBe(2);

    // But no API calls made
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).not.toHaveBeenCalled();
  });

  it("removes _triage label from ALL reviewed messages (both star and archive)", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-1", "star"],
      ["msg-2", "archive"],
    ]);

    await finalizeReview(decisions, "lbl-triage-id", client);

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    const calls: Array<[string[], string[] | undefined, string[] | undefined]> = batchModifyMock.mock.calls;

    // Every call should include removal of triage label
    const triageRemovedCalls = calls.filter((c) => {
      const [, , removeLabels] = c;
      return removeLabels?.includes("lbl-triage-id") === true;
    });

    // All IDs in decisions must have triage label removed
    const allRemovedIds = triageRemovedCalls.flatMap(([ids]) => ids);
    expect(allRemovedIds).toContain("msg-1");
    expect(allRemovedIds).toContain("msg-2");
  });

  it("returns error when batchModifyMessages fails for star batch", async () => {
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    batchModifyMock.mockResolvedValue({ ok: false, error: "star modify failed" });

    const decisions = new Map<string, "star" | "archive">([["msg-1", "star"]]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/star modify failed/);
  });

  it("returns error when batchModifyMessages fails for archive batch", async () => {
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    batchModifyMock.mockResolvedValue({ ok: false, error: "archive modify failed" });

    const decisions = new Map<string, "star" | "archive">([["msg-1", "archive"]]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/archive modify failed/);
  });

  it("returns error when batchModifyMessages throws for archive batch", async () => {
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    batchModifyMock.mockRejectedValue(new Error("write exploded"));

    const decisions = new Map<string, "star" | "archive">([["msg-1", "archive"]]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/batchModifyMessages threw/i);
    expect(result.error).toMatch(/write exploded/);
  });

  it("handles mixed star and archive decisions with separate API calls", async () => {
    const decisions = new Map<string, "star" | "archive">([
      ["msg-1", "star"],
      ["msg-2", "star"],
      ["msg-3", "archive"],
    ]);

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    // Should have at least 2 calls: one for stars, one for archives
    expect(batchModifyMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("chunks review writes to Gmail's 1000-ID batchModify limit", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock
      .mockResolvedValueOnce({
        ok: true,
        value: {
          messages: makeMessageStubs(0, 500),
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          messages: makeMessageStubs(500, 500),
          nextPageToken: "page-3",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          messages: makeMessageStubs(1000, 1),
        },
      });

    const decisions = new Map<string, "star" | "archive">(
      Array.from({ length: 1001 }, (_, index) => [`msg-${index}`, "star"] as const),
    );

    const result = await finalizeReview(decisions, "lbl-triage-id", client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).toHaveBeenCalledTimes(2);
    expect(batchModifyMock.mock.calls[0]?.[0]).toHaveLength(1000);
    expect(batchModifyMock.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("returns error when finalizeReview sees a triage queue above the safety limit", async () => {
    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;

    // 20 pages of 500 = 10,000 messages, with a next-page token on every page
    for (let page = 0; page < 20; page++) {
      listMessagesMock.mockResolvedValueOnce({
        ok: true,
        value: {
          messages: makeMessageStubs(page * 500, 500),
          nextPageToken: `page-${page + 2}`,
        },
      });
    }

    const result = await finalizeReview(new Map([["msg-0", "archive" as const]]), "lbl-triage-id", client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/safety limit/i);
    expect(result.error).toMatch(/partial action pass/i);
  });
});
