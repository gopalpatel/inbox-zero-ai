import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockGmailApi } from "../helpers/test-utils.js";

const ORIGINAL_ENV = { ...process.env };

// ---------------------------------------------------------------------------
// Module-level mock for googleapis so no real network calls are made.
// The mock is defined before any import of the module under test so that
// vi.mock() hoisting kicks in correctly.
// ---------------------------------------------------------------------------

vi.mock("googleapis", () => {
  // Use a class so `new google.auth.GoogleAuth(...)` works in production code.
  class MockGoogleAuth {
    scopes: string[];
    constructor(opts: { scopes?: string[] } = {}) {
      this.scopes = opts.scopes ?? [];
    }
  }

  return {
    google: {
      auth: {
        getApplicationDefault: vi.fn().mockResolvedValue({
          credential: { type: "authorized_user" },
        }),
        GoogleAuth: MockGoogleAuth,
      },
      gmail: vi.fn(),
    },
  };
});

// Import after mock registration.
import { google } from "googleapis";
import { createGmailClient, type GmailClient } from "../../src/auth/gmail-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGmailMock(): ReturnType<typeof vi.fn> {
  return google.gmail as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("createGmailClient()", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;

  beforeEach(() => {
    mockApi = createMockGmailApi();
    getGmailMock().mockReturnValue(mockApi);
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    delete process.env.GMAIL_USER;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns a client exposing all required public methods", async () => {
    const client = await createGmailClient();
    expect(typeof client.getProfile).toBe("function");
    expect(typeof client.listMessages).toBe("function");
    expect(typeof client.getMessage).toBe("function");
    expect(typeof client.batchModifyMessages).toBe("function");
    expect(typeof client.listLabels).toBe("function");
    expect(typeof client.listFilters).toBe("function");
    expect(typeof client.createLabel).toBe("function");
    expect(typeof client.createFilter).toBe("function");
    expect(typeof client.deleteFilter).toBe("function");
  });

  it("requests Gmail modify and settings scopes", async () => {
    await createGmailClient();

    const gmailFactoryCall = getGmailMock().mock.calls[0]?.[0] as { auth?: { scopes?: string[] } } | undefined;

    expect(gmailFactoryCall?.auth?.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ]);
  });

  it("fails fast when service-account mode is enabled without GMAIL_USER", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "/tmp/fake-key.json";
    delete process.env.GMAIL_USER;

    await expect(createGmailClient()).rejects.toThrow(
      "GMAIL_USER is required when GOOGLE_SERVICE_ACCOUNT_KEY is set",
    );
  });
});

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe("Rate limiter", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;

  beforeEach(() => {
    mockApi = createMockGmailApi();
    getGmailMock().mockReturnValue(mockApi);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("allows up to QPS calls per second without delay", async () => {
    // QPS=2 — two calls in the same second should fire immediately.
    const client = await createGmailClient({ qps: 2 });

    const p1 = client.getProfile();
    const p2 = client.getProfile();

    // Advance time by less than 1 second — both should resolve.
    await vi.runAllTimersAsync();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(2);
  });

  it("delays the (QPS+1)th call to the next second window", async () => {
    const qps = 2;
    const client = await createGmailClient({ qps });

    // Fire QPS+1 calls concurrently.
    const promises = Array.from({ length: qps + 1 }, () => client.getProfile());

    // After <1 s only QPS calls should have been dispatched.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(qps);

    // After >1 s the extra call can proceed.
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all(promises);
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(qps + 1);
  });
});

// ---------------------------------------------------------------------------
// Retry logic tests
// ---------------------------------------------------------------------------

describe("Retry logic", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;

  beforeEach(() => {
    mockApi = createMockGmailApi();
    getGmailMock().mockReturnValue(mockApi);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("retries on HTTP 429 (rate limit exceeded) up to max retries then succeeds", async () => {
    const client = await createGmailClient({ qps: 100, maxRetries: 3 });

    // Fail twice with 429, then succeed.
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), { code: 429 });
    mockApi.users.getProfile
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ data: { emailAddress: "test@example.com", messagesTotal: 5 } });

    const promise = client.getProfile();
    // Advance timers past all backoff delays (1s, 2s).
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(3);
  });

  it("retries on HTTP 503 (service unavailable) up to max retries then succeeds", async () => {
    const client = await createGmailClient({ qps: 100, maxRetries: 3 });

    const serviceError = Object.assign(new Error("Service Unavailable"), { code: 503 });
    mockApi.users.getProfile
      .mockRejectedValueOnce(serviceError)
      .mockResolvedValueOnce({ data: { emailAddress: "test@example.com", messagesTotal: 10 } });

    const promise = client.getProfile();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(2);
  });

  it("exhausts max retries on persistent 429 and returns error result", async () => {
    const maxRetries = 2;
    const client = await createGmailClient({ qps: 100, maxRetries });

    const rateLimitError = Object.assign(new Error("Rate limit"), { code: 429 });
    mockApi.users.getProfile.mockRejectedValue(rateLimitError);

    const promise = client.getProfile();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    // Called once initially + maxRetries attempts.
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(maxRetries + 1);
  });

  it("does NOT retry on HTTP 401 (auth error)", async () => {
    const client = await createGmailClient({ qps: 100, maxRetries: 3 });

    const authError = Object.assign(new Error("Unauthorized"), { code: 401 });
    mockApi.users.getProfile.mockRejectedValue(authError);

    const promise = client.getProfile();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    // No retries — only the initial call.
    expect(mockApi.users.getProfile).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on HTTP 400 (bad request)", async () => {
    const client = await createGmailClient({ qps: 100, maxRetries: 3 });

    const badRequestError = Object.assign(new Error("Bad Request"), { code: 400 });
    mockApi.users.messages.list.mockRejectedValue(badRequestError);

    const promise = client.listMessages("invalid:query");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(mockApi.users.messages.list).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Method smoke tests — shape of returned data
// ---------------------------------------------------------------------------

describe("getProfile() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      profile: { emailAddress: "mail@example.com", messagesTotal: 671000 },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ok: true, value: { emailAddress, messagesTotal } }", async () => {
    const result = await client.getProfile();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.emailAddress).toBe("mail@example.com");
    expect(result.value.messagesTotal).toBe(671000);
  });
});

describe("listMessages() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      listMessages: {
        messages: [
          { id: "msg-001", threadId: "thread-001" },
          { id: "msg-002", threadId: "thread-002" },
        ],
        nextPageToken: "token-abc",
        resultSizeEstimate: 671234,
      },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns messages array and nextPageToken", async () => {
    const result = await client.listMessages("in:inbox");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.messages).toHaveLength(2);
    expect(result.value.messages[0]!.id).toBe("msg-001");
    expect(result.value.nextPageToken).toBe("token-abc");
    expect(result.value.resultSizeEstimate).toBe(671234);
  });

  it("passes pageToken and maxResults to underlying API", async () => {
    await client.listMessages("in:inbox", "page-token", 50);

    expect(mockApi.users.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({
        pageToken: "page-token",
        maxResults: 50,
      }),
    );
  });
});

describe("getMessage() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      getMessage: { id: "msg-xyz", threadId: "thread-xyz", snippet: "Hello" },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the message object", async () => {
    const result = await client.getMessage("msg-xyz");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.id).toBe("msg-xyz");
    expect(result.value.snippet).toBe("Hello");
  });

  it("passes format and metadataHeaders to underlying API", async () => {
    await client.getMessage("msg-xyz", "metadata", ["From", "Subject"]);

    expect(mockApi.users.messages.get).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      }),
    );
  });
});

describe("batchModifyMessages() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi();
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ok: true, value: undefined } on success", async () => {
    const result = await client.batchModifyMessages(["msg-001", "msg-002"], ["LABEL_A"], ["UNREAD"]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toBeUndefined();
    expect(mockApi.users.messages.batchModify).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          ids: ["msg-001", "msg-002"],
          addLabelIds: ["LABEL_A"],
          removeLabelIds: ["UNREAD"],
        }),
      }),
    );
  });
});

describe("listLabels() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      listLabels: {
        labels: [
          { id: "INBOX", name: "INBOX" },
          { id: "UNREAD", name: "UNREAD" },
        ],
      },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an array of labels", async () => {
    const result = await client.listLabels();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(2);
    expect(result.value[0]!.id).toBe("INBOX");
  });
});

describe("listFilters() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      listFilters: {
        filter: [
          { id: "filter-001", criteria: { from: "newsletter@example.com" }, action: { addLabelIds: ["Label_1"] } },
        ],
      },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an array of filters", async () => {
    const result = await client.listFilters();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.id).toBe("filter-001");
    expect(mockApi.users.settings.filters.list).toHaveBeenCalledWith(expect.objectContaining({ userId: "me" }));
  });
});

describe("createLabel() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      createLabel: { id: "Label_123", name: "MyNewLabel" },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the created label", async () => {
    const result = await client.createLabel("MyNewLabel");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.id).toBe("Label_123");
    expect(result.value.name).toBe("MyNewLabel");
    expect(mockApi.users.labels.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ name: "MyNewLabel" }),
      }),
    );
  });
});

describe("createFilter() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi({
      createFilter: { id: "ANe1BmjOAbc", criteria: { from: "spam@example.com" }, action: { addLabelIds: ["TRASH"] } },
    });
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the created filter", async () => {
    const result = await client.createFilter({ from: "spam@example.com" }, { addLabelIds: ["TRASH"] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.id).toBe("ANe1BmjOAbc");
    expect(mockApi.users.settings.filters.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          criteria: { from: "spam@example.com" },
          action: { addLabelIds: ["TRASH"] },
        }),
      }),
    );
  });

  it("passes query criteria through to the API", async () => {
    const result = await client.createFilter(
      { query: "list:notifications@github.com" },
      { addLabelIds: ["Label_noise"] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(mockApi.users.settings.filters.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          criteria: { query: "list:notifications@github.com" },
          action: { addLabelIds: ["Label_noise"] },
        }),
      }),
    );
  });

  it("passes both from and query criteria through to the API", async () => {
    const result = await client.createFilter(
      { from: "noreply@github.com", query: "subject:CI" },
      { addLabelIds: ["Label_ci"], removeLabelIds: ["INBOX"] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(mockApi.users.settings.filters.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          criteria: { from: "noreply@github.com", query: "subject:CI" },
          action: { addLabelIds: ["Label_ci"], removeLabelIds: ["INBOX"] },
        }),
      }),
    );
  });
});

describe("deleteFilter() smoke test", () => {
  let mockApi: ReturnType<typeof createMockGmailApi>;
  let client: GmailClient;

  beforeEach(async () => {
    mockApi = createMockGmailApi();
    getGmailMock().mockReturnValue(mockApi);
    client = await createGmailClient({ qps: 100 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ok: true, value: undefined } on successful deletion", async () => {
    const result = await client.deleteFilter("filter-abc-123");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toBeUndefined();
    expect(mockApi.users.settings.filters.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        id: "filter-abc-123",
      }),
    );
  });

  it("returns { ok: false, error } on API error", async () => {
    const notFoundError = Object.assign(new Error("Filter not found"), { code: 404 });
    mockApi.users.settings.filters.delete.mockRejectedValueOnce(notFoundError);

    const result = await client.deleteFilter("nonexistent-filter");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected result.ok to be false");

    expect(result.error).toBe("Filter not found");
  });
});
