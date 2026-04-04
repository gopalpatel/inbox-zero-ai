/**
 * Unit tests for GraphClient — the rate-limited, retry-aware Microsoft Graph wrapper.
 *
 * Tests cover:
 * - getProfile() returns mailbox identity
 * - listFolders() with pagination
 * - listMessages() with pagination ($top, @odata.nextLink)
 * - followNextLink() validates Graph origin before following pagination URLs
 * - getMessage(id) retrieval by immutable ID
 * - moveMessages() chunking via GRAPH_BATCH_CHUNK_SIZE
 * - patchMessages() chunking for category assignment
 * - Retry on 429/503 with exponential backoff
 * - Non-retryable errors (400/404) return error Result
 * - Rate limiting via TokenBucketLimiter (15 QPS)
 * - Immutable ID header on all requests
 * - listCategories, createCategory, listRules, createRule, deleteRule
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock builder — simulates the Graph SDK client.api(path) chain
// ---------------------------------------------------------------------------

interface MockRequestBuilder {
  header: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  filter: ReturnType<typeof vi.fn>;
  orderby: ReturnType<typeof vi.fn>;
  skipToken: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/** Tracks all api() calls with their paths for assertion. */
interface MockClient {
  api: ReturnType<typeof vi.fn>;
}

/**
 * Creates a mock Graph SDK client with a chainable builder.
 * Every builder method returns `this` (the builder) to support chaining.
 * `get`, `post`, `patch`, `delete` resolve with `getResult`.
 */
function createMockGraphClient(getResult: unknown = {}): {
  client: MockClient;
  builder: MockRequestBuilder;
} {
  const builder: MockRequestBuilder = {
    header: vi.fn(),
    select: vi.fn(),
    top: vi.fn(),
    filter: vi.fn(),
    orderby: vi.fn(),
    skipToken: vi.fn(),
    get: vi.fn().mockResolvedValue(getResult),
    post: vi.fn().mockResolvedValue(getResult),
    patch: vi.fn().mockResolvedValue(getResult),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  // All chainable methods return the builder itself.
  builder.header.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.top.mockReturnValue(builder);
  builder.filter.mockReturnValue(builder);
  builder.orderby.mockReturnValue(builder);
  builder.skipToken.mockReturnValue(builder);

  const client: MockClient = {
    api: vi.fn().mockReturnValue(builder),
  };

  return { client, builder };
}

// ---------------------------------------------------------------------------
// Dynamic import of the module under test (no top-level so mocking works)
// ---------------------------------------------------------------------------

async function createTestClient(
  mockClient: MockClient,
  opts?: { qps?: number; maxRetries?: number; initialRetryDelayMs?: number; userEmail?: string },
) {
  const { GraphClient } = await import("../../src/auth/graph-client.js");
  // Cast the mock to satisfy the Client type expected by GraphClient.
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  return new GraphClient(mockClient as any, opts?.userEmail ?? "user@example.com", opts);
}

// ---------------------------------------------------------------------------
// getProfile()
// ---------------------------------------------------------------------------

describe("GraphClient.getProfile()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { emailAddress, displayName } from /users/{email}", async () => {
    const { client, builder } = createMockGraphClient({
      displayName: "Gopal Patel",
      mail: "mailbox@example.com",
      userPrincipalName: "mailbox@example.com",
    });

    const gc = await createTestClient(client);
    const result = await gc.getProfile();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.emailAddress).toBe("mailbox@example.com");
    expect(result.value.displayName).toBe("Gopal Patel");

    // Verify API path
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com");

    // Verify immutable ID header
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');

    // Verify select fields
    expect(builder.select).toHaveBeenCalledWith(["displayName", "mail", "userPrincipalName"]);
  });

  it("returns error Result on API failure", async () => {
    const { client, builder } = createMockGraphClient();
    builder.get.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { statusCode: 403 }));

    const gc = await createTestClient(client);
    const result = await gc.getProfile();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
// listFolders()
// ---------------------------------------------------------------------------

describe("GraphClient.listFolders()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns folders with totalItemCount and unreadItemCount", async () => {
    const { client, builder } = createMockGraphClient({
      value: [
        {
          id: "f1",
          displayName: "Inbox",
          totalItemCount: 500,
          unreadItemCount: 10,
          parentFolderId: "root",
          childFolderCount: 1,
        },
        { id: "f2", displayName: "Sent Items", totalItemCount: 200, unreadItemCount: 0 },
      ],
    });

    const gc = await createTestClient(client);
    const result = await gc.listFolders();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toHaveLength(2);
    expect(result.value[0]!.displayName).toBe("Inbox");
    expect(result.value[0]!.totalItemCount).toBe(500);
    expect(result.value[0]!.unreadItemCount).toBe(10);
    expect(result.value[0]!.parentFolderId).toBe("root");
    expect(result.value[0]!.childFolderCount).toBe(1);
    expect(result.value[1]!.displayName).toBe("Sent Items");

    // Verify immutable ID header
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });

  it("follows @odata.nextLink for paginated folders", async () => {
    const { client } = createMockGraphClient();
    // We need different responses per call to simulate pagination.
    // Override the builder's get() on each api() call.
    let callCount = 0;
    client.api.mockImplementation(() => {
      callCount++;
      const builder: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(
          callCount === 1
            ? {
                value: [{ id: "f1", displayName: "Inbox", totalItemCount: 10, unreadItemCount: 1 }],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/user@example.com/mailFolders?$skip=100",
              }
            : {
                value: [{ id: "f2", displayName: "Drafts", totalItemCount: 5, unreadItemCount: 0 }],
              },
        ),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      // chainable methods return builder
      return builder;
    });

    const gc = await createTestClient(client);
    const result = await gc.listFolders();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toHaveLength(2);
    expect(result.value[0]!.displayName).toBe("Inbox");
    expect(result.value[1]!.displayName).toBe("Drafts");
    expect(client.api).toHaveBeenCalledTimes(2);
  });

  it("recursively loads child folders", async () => {
    const { client } = createMockGraphClient();
    client.api.mockImplementation((path: string) => {
      const builder: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(
          path === "/users/user%40example.com/mailFolders"
            ? {
                value: [
                  {
                    id: "root-archive",
                    displayName: "Archive",
                    totalItemCount: 10,
                    unreadItemCount: 0,
                    childFolderCount: 1,
                  },
                ],
              }
            : {
                value: [
                  {
                    id: "project-folder",
                    displayName: "Projects",
                    totalItemCount: 7,
                    unreadItemCount: 2,
                    parentFolderId: "root-archive",
                    childFolderCount: 0,
                  },
                ],
              },
        ),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      return builder;
    });

    const gc = await createTestClient(client);
    const result = await gc.listFolders();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.map((folder) => folder.displayName)).toEqual(["Archive", "Projects"]);
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/mailFolders/root-archive/childFolders");
  });

  it("fails when pagination is truncated by the folder safety cap mid-chain", async () => {
    const { client } = createMockGraphClient();
    client.api.mockImplementation(() => {
      const builder: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({
          value: [{ id: "f1", displayName: "Inbox", totalItemCount: 10, unreadItemCount: 1 }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/user@example.com/mailFolders?$skip=100",
        }),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      return builder;
    });

    const gc = await createTestClient(client, { qps: 10_000 });
    const result = await gc.listFolders();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toMatch(/Exceeded MAX_PAGES/);
  }, 15_000);
});

describe("GraphClient.getMailFolder()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a default folder by well-known name", async () => {
    const { client, builder } = createMockGraphClient({
      id: "archive-folder-id",
      displayName: "Archiv",
      totalItemCount: 42,
      unreadItemCount: 0,
    });

    const gc = await createTestClient(client);
    const result = await gc.getMailFolder("archive");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.id).toBe("archive-folder-id");
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/mailFolders/archive");
    expect(builder.select).toHaveBeenCalledWith([
      "id",
      "displayName",
      "totalItemCount",
      "unreadItemCount",
      "parentFolderId",
      "childFolderCount",
    ]);
  });
});

// ---------------------------------------------------------------------------
// listMessages()
// ---------------------------------------------------------------------------

describe("GraphClient.listMessages()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns messages with nextLink for pagination", async () => {
    const { client, builder } = createMockGraphClient({
      value: [
        {
          id: "msg-001",
          conversationId: "conv-001",
          subject: "Hello",
          receivedDateTime: "2026-03-20T10:00:00Z",
          categories: [],
          isRead: false,
          parentFolderId: "inbox-id",
          bodyPreview: "Hello world",
          flag: { flagStatus: "notFlagged" },
          importance: "normal",
          from: { emailAddress: { address: "alice@example.com", name: "Alice" } },
          toRecipients: [{ emailAddress: { address: "user@example.com", name: "User" } }],
          ccRecipients: [],
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=50",
    });

    const gc = await createTestClient(client);
    const result = await gc.listMessages({ top: 50 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.messages).toHaveLength(1);
    expect(result.value.nextLink).toBe("https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=50");

    // Verify $top was called
    expect(builder.top).toHaveBeenCalledWith(50);

    // Verify immutable ID header
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });

  it("passes filter and skipToken options", async () => {
    const { client, builder } = createMockGraphClient({ value: [] });

    const gc = await createTestClient(client);
    await gc.listMessages({
      filter: "isRead eq false",
      skipToken: "some-token",
    });

    expect(builder.filter).toHaveBeenCalledWith("isRead eq false");
    expect(builder.skipToken).toHaveBeenCalledWith("some-token");
  });

  it("passes select fields when provided", async () => {
    const { client, builder } = createMockGraphClient({ value: [] });

    const gc = await createTestClient(client);
    await gc.listMessages({ select: ["id", "subject", "receivedDateTime"] });

    expect(builder.select).toHaveBeenCalledWith(["id", "subject", "receivedDateTime"]);
  });

  it("normalizes partial message payloads when a narrow select is used", async () => {
    const { client } = createMockGraphClient({
      value: [{ id: "msg-partial" }],
    });

    const gc = await createTestClient(client);
    const result = await gc.listMessages({ select: ["id"] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.messages[0]).toEqual({
      id: "msg-partial",
      conversationId: "msg-partial",
      from: undefined,
      toRecipients: [],
      ccRecipients: [],
      subject: "",
      receivedDateTime: "",
      categories: [],
      isRead: false,
      parentFolderId: "",
      bodyPreview: "",
      flag: { flagStatus: "" },
      importance: "",
    });
  });

  it("falls back conversationId to id when Graph omits it", async () => {
    const { client } = createMockGraphClient({
      value: [{ id: "msg-missing-conversation" }],
    });

    const gc = await createTestClient(client);
    const result = await gc.listMessages({ top: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.messages[0]?.conversationId).toBe("msg-missing-conversation");
  });
});

// ---------------------------------------------------------------------------
// followNextLink()
// ---------------------------------------------------------------------------

describe("GraphClient.followNextLink()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows Graph nextLink URLs from the expected origin", async () => {
    const { client, builder } = createMockGraphClient({
      value: [{ id: "msg-002" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=100",
    });

    const gc = await createTestClient(client);
    const result = await gc.followNextLink("https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=50");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(client.api).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=50",
    );
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
    expect(result.value.nextLink).toBe("https://graph.microsoft.com/v1.0/users/user@example.com/messages?$skip=100");
  });

  it("rejects nextLink URLs from non-Graph origins", async () => {
    const { client } = createMockGraphClient({
      value: [{ id: "msg-003" }],
    });

    const gc = await createTestClient(client);
    const result = await gc.followNextLink("https://example.com/v1.0/users/user@example.com/messages?$skip=50");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Invalid nextLink origin: https://example.com");
    expect(client.api).not.toHaveBeenCalled();
  });

  it("rejects same-origin nextLink URLs for a different mailbox or collection", async () => {
    const { client } = createMockGraphClient({
      value: [{ id: "msg-004" }],
    });

    const gc = await createTestClient(client, { userEmail: "user@example.com" });

    const wrongUserResult = await gc.followNextLink(
      "https://graph.microsoft.com/v1.0/users/other@example.com/messages?$skip=50",
    );
    expect(wrongUserResult.ok).toBe(false);
    if (wrongUserResult.ok) throw new Error("Expected failure");
    expect(wrongUserResult.error).toBe("Invalid nextLink path: /v1.0/users/other@example.com/messages");

    const wrongCollectionResult = await gc.followNextLink(
      "https://graph.microsoft.com/v1.0/users/user@example.com/mailFolders?$skip=50",
    );
    expect(wrongCollectionResult.ok).toBe(false);
    if (wrongCollectionResult.ok) throw new Error("Expected failure");
    expect(wrongCollectionResult.error).toBe("Invalid nextLink path: /v1.0/users/user@example.com/mailFolders");
    expect(client.api).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getMessage()
// ---------------------------------------------------------------------------

describe("GraphClient.getMessage()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retrieves a message by immutable ID", async () => {
    const message = {
      id: "AAMkADAwATZiZmYAZC0",
      conversationId: "conv-x",
      subject: "Important",
      receivedDateTime: "2026-03-20T10:00:00Z",
      categories: ["_noise"],
      isRead: true,
      parentFolderId: "inbox-id",
      bodyPreview: "Preview text",
      flag: { flagStatus: "notFlagged" },
      importance: "high",
      from: { emailAddress: { address: "boss@example.com", name: "Boss" } },
      toRecipients: [],
      ccRecipients: [],
    };
    const { client, builder } = createMockGraphClient(message);

    const gc = await createTestClient(client);
    const result = await gc.getMessage("AAMkADAwATZiZmYAZC0");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toEqual(message);
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/messages/AAMkADAwATZiZmYAZC0");
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });

  it("immutable ID from listMessages can be used with getMessage", async () => {
    // Simulate listing messages then fetching one by ID — both use the same immutable ID.
    const immutableId = "AAMkADAwATZiZmYAZC0-immutable";
    const listResponse = {
      value: [
        {
          id: immutableId,
          conversationId: "conv-1",
          subject: "Test",
          receivedDateTime: "2026-03-20T10:00:00Z",
          categories: [],
          isRead: false,
          parentFolderId: "inbox-id",
          bodyPreview: "",
          flag: { flagStatus: "notFlagged" },
          importance: "normal",
          from: { emailAddress: { address: "a@b.com", name: "A" } },
          toRecipients: [],
          ccRecipients: [],
        },
      ],
    };
    const getMessage = {
      id: immutableId,
      conversationId: "conv-1",
      subject: "Test",
      receivedDateTime: "2026-03-20T10:00:00Z",
      categories: [],
      isRead: false,
      parentFolderId: "inbox-id",
      bodyPreview: "",
      flag: { flagStatus: "notFlagged" },
      importance: "normal",
      from: { emailAddress: { address: "a@b.com", name: "A" } },
      toRecipients: [],
      ccRecipients: [],
    };

    // Create mock that returns different responses per path.
    const mockClient: MockClient = { api: vi.fn() };
    let callIdx = 0;
    mockClient.api.mockImplementation(() => {
      callIdx++;
      const response = callIdx === 1 ? listResponse : getMessage;
      const b: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(response),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      return b;
    });

    const gc = await createTestClient(mockClient);

    // Step 1: list messages
    const listResult = await gc.listMessages({});
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) throw new Error("Expected ok");
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const listedId = (listResult.value.messages[0] as any).id;
    expect(listedId).toBe(immutableId);

    // Step 2: fetch that same message by its immutable ID
    const getResult = await gc.getMessage(listedId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) throw new Error("Expected ok");
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    expect((getResult.value as any).id).toBe(immutableId);

    // Verify the second call used the immutable ID in the path
    expect(mockClient.api).toHaveBeenCalledWith(`/users/user%40example.com/messages/${immutableId}`);
  });

  it("URL-encodes userEmail and opaque Graph IDs in message and rule paths", async () => {
    const { client } = createMockGraphClient({ id: "ok" });
    client.api.mockImplementation(() => {
      const builder: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({ id: "msg" }),
        post: vi.fn().mockResolvedValue({ id: "moved" }),
        patch: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      return builder;
    });

    const gc = await createTestClient(client, { userEmail: "user+alias@example.com" });
    await gc.getMessage("msg/+=id");
    await gc.moveMessages(["move/+=id"], "archive-folder-id");
    await gc.patchMessages(["patch/+=id"], { categories: ["_noise"] });
    await gc.deleteRule("rule/+=id");

    expect(client.api).toHaveBeenCalledWith("/users/user%2Balias%40example.com/messages/msg%2F%2B%3Did");
    expect(client.api).toHaveBeenCalledWith("/users/user%2Balias%40example.com/messages/move%2F%2B%3Did/move");
    expect(client.api).toHaveBeenCalledWith("/users/user%2Balias%40example.com/messages/patch%2F%2B%3Did");
    expect(client.api).toHaveBeenCalledWith(
      "/users/user%2Balias%40example.com/mailFolders/inbox/messageRules/rule%2F%2B%3Did",
    );
  });
});

// ---------------------------------------------------------------------------
// moveMessages() — chunking
// ---------------------------------------------------------------------------

describe("GraphClient.moveMessages()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves messages one by one, chunked by GRAPH_BATCH_CHUNK_SIZE=20", async () => {
    // Create 25 message IDs — should result in 2 chunks (20 + 5).
    const messageIds = Array.from({ length: 25 }, (_, i) => `msg-${String(i).padStart(3, "0")}`);

    const { client } = createMockGraphClient({});
    // Each move call creates a new builder via api(), so we need per-call builders.
    client.api.mockImplementation(() => {
      const b: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn(),
        post: vi.fn().mockResolvedValue({ id: "moved" }),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      return b;
    });

    const gc = await createTestClient(client);
    const result = await gc.moveMessages(messageIds, "archive-folder-id");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.moved).toBe(25);
    expect(result.value.errors).toBe(0);
    expect(result.value.failures).toEqual([]);

    // Verify all 25 move calls were made.
    expect(client.api).toHaveBeenCalledTimes(25);

    // Verify each call used the correct path.
    for (let i = 0; i < 25; i++) {
      expect(client.api).toHaveBeenCalledWith(
        `/users/user%40example.com/messages/msg-${String(i).padStart(3, "0")}/move`,
      );
    }
  });

  it("reports partial failures when some moves fail", async () => {
    const messageIds = ["msg-001", "msg-002", "msg-003"];
    const { client } = createMockGraphClient();
    let idx = 0;
    client.api.mockImplementation(() => {
      idx++;
      const b: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn(),
        post:
          idx === 2
            ? vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { statusCode: 404 }))
            : vi.fn().mockResolvedValue({ id: "moved" }),
        patch: vi.fn(),
        delete: vi.fn(),
      };
      return b;
    });

    const gc = await createTestClient(client, { maxRetries: 0 });
    const result = await gc.moveMessages(messageIds, "folder-id");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.moved).toBe(2);
    expect(result.value.errors).toBe(1);
    expect(result.value.failures).toEqual([
      {
        messageId: "msg-002",
        error: "Not Found",
        statusCode: 404,
        code: undefined,
        kind: "not_found",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// patchMessages() — chunking for categories
// ---------------------------------------------------------------------------

describe("GraphClient.patchMessages()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("patches messages with categories, chunked by GRAPH_BATCH_CHUNK_SIZE=20", async () => {
    const messageIds = Array.from({ length: 22 }, (_, i) => `msg-${String(i).padStart(3, "0")}`);

    const { client } = createMockGraphClient();
    client.api.mockImplementation(() => {
      const b: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
      };
      return b;
    });

    const gc = await createTestClient(client);
    const result = await gc.patchMessages(messageIds, { categories: ["_noise"] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.patched).toBe(22);
    expect(result.value.errors).toBe(0);
    expect(result.value.failures).toEqual([]);

    // Verify all 22 patch calls were made.
    expect(client.api).toHaveBeenCalledTimes(22);
  });

  it("reports partial failures when some patches fail", async () => {
    const messageIds = ["msg-001", "msg-002"];
    const { client } = createMockGraphClient();
    let idx = 0;
    client.api.mockImplementation(() => {
      idx++;
      const b: MockRequestBuilder = {
        header: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        top: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        orderby: vi.fn().mockReturnThis(),
        skipToken: vi.fn().mockReturnThis(),
        get: vi.fn(),
        post: vi.fn(),
        patch:
          idx === 1
            ? vi.fn().mockRejectedValue(Object.assign(new Error("Bad Request"), { statusCode: 400 }))
            : vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
      };
      return b;
    });

    const gc = await createTestClient(client, { maxRetries: 0 });
    const result = await gc.patchMessages(messageIds, { categories: ["_noise"] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.patched).toBe(1);
    expect(result.value.errors).toBe(1);
    expect(result.value.failures).toEqual([
      {
        messageId: "msg-001",
        error: "Bad Request",
        statusCode: 400,
        code: undefined,
        kind: "other",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

describe("GraphClient retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries on HTTP 429 (throttled) and eventually succeeds", async () => {
    const { client, builder } = createMockGraphClient();
    const throttleError = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

    builder.get.mockRejectedValueOnce(throttleError).mockRejectedValueOnce(throttleError).mockResolvedValueOnce({
      displayName: "User",
      mail: "user@example.com",
      userPrincipalName: "user@example.com",
    });

    const gc = await createTestClient(client, { qps: 100, maxRetries: 5, initialRetryDelayMs: 100 });
    const promise = gc.getProfile();

    // Advance past backoff delays (100ms, 200ms).
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(builder.get).toHaveBeenCalledTimes(3);
  });

  it("retries on HTTP 503 (service unavailable) and eventually succeeds", async () => {
    const { client, builder } = createMockGraphClient();
    const serviceError = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });

    builder.get.mockRejectedValueOnce(serviceError).mockResolvedValueOnce({
      displayName: "User",
      mail: "user@example.com",
      userPrincipalName: "user@example.com",
    });

    const gc = await createTestClient(client, { qps: 100, maxRetries: 5, initialRetryDelayMs: 100 });
    const promise = gc.getProfile();
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(builder.get).toHaveBeenCalledTimes(2);
  });

  it("exhausts max retries on persistent 429 and returns error Result", async () => {
    const maxRetries = 2;
    const { client, builder } = createMockGraphClient();
    const throttleError = Object.assign(new Error("Throttled"), { statusCode: 429 });
    builder.get.mockRejectedValue(throttleError);

    const gc = await createTestClient(client, { qps: 100, maxRetries, initialRetryDelayMs: 100 });
    const promise = gc.getProfile();
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(false);
    // 1 initial + maxRetries = maxRetries+1 total calls.
    expect(builder.get).toHaveBeenCalledTimes(maxRetries + 1);
  });

  it("does NOT retry on HTTP 400 (bad request)", async () => {
    const { client, builder } = createMockGraphClient();
    const badRequest = Object.assign(new Error("Bad Request"), { statusCode: 400 });
    builder.get.mockRejectedValue(badRequest);

    const gc = await createTestClient(client, { qps: 100, maxRetries: 5, initialRetryDelayMs: 100 });
    const promise = gc.getProfile();
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Bad Request");
    // Only one attempt — no retries.
    expect(builder.get).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on HTTP 404 (not found)", async () => {
    const { client, builder } = createMockGraphClient();
    const notFound = Object.assign(new Error("Not Found"), { statusCode: 404 });
    builder.get.mockRejectedValue(notFound);

    const gc = await createTestClient(client, { qps: 100, maxRetries: 5, initialRetryDelayMs: 100 });
    const promise = gc.getProfile();
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(builder.get).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry transient failures for Graph mutations", async () => {
    const { client, builder } = createMockGraphClient();
    const throttled = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    builder.post.mockRejectedValue(throttled);

    const gc = await createTestClient(client, { qps: 100, maxRetries: 5, initialRetryDelayMs: 100 });
    const promise = gc.createRule({
      displayName: "Auto-archive noise",
      conditions: { senderContains: ["noreply@"] },
      actions: { moveToFolder: "archive-id" },
      isEnabled: true,
    });
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Too Many Requests");
    expect(builder.post).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("GraphClient rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("allows up to QPS calls per second without delay", async () => {
    const qps = 3;
    const { client, builder } = createMockGraphClient({
      displayName: "User",
      mail: "user@example.com",
      userPrincipalName: "user@example.com",
    });

    const gc = await createTestClient(client, { qps });

    // Fire QPS calls concurrently.
    const promises = Array.from({ length: qps }, () => gc.getProfile());
    await vi.runAllTimersAsync();
    const results = await Promise.all(promises);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
    expect(builder.get).toHaveBeenCalledTimes(qps);
  });

  it("delays the (QPS+1)th call to the next second window", async () => {
    const qps = 2;
    const { client, builder } = createMockGraphClient({
      displayName: "User",
      mail: "user@example.com",
      userPrincipalName: "user@example.com",
    });

    const gc = await createTestClient(client, { qps });

    // Fire QPS+1 calls concurrently.
    const promises = Array.from({ length: qps + 1 }, () => gc.getProfile());

    // After <1s, only QPS calls should have been dispatched.
    await vi.advanceTimersByTimeAsync(500);
    expect(builder.get).toHaveBeenCalledTimes(qps);

    // After >1s the extra call can proceed.
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all(promises);
    expect(builder.get).toHaveBeenCalledTimes(qps + 1);
  });

  it("does not release a whole backlog into the same next window", async () => {
    const { client, builder } = createMockGraphClient({
      displayName: "User",
      mail: "user@example.com",
      userPrincipalName: "user@example.com",
    });

    const gc = await createTestClient(client, { qps: 1 });
    const promises = [gc.getProfile(), gc.getProfile(), gc.getProfile()];

    await vi.advanceTimersByTimeAsync(999);
    expect(builder.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(builder.get).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(promises);
    expect(builder.get).toHaveBeenCalledTimes(3);
  });
});

describe("GraphClient constructor validation", () => {
  it("rejects invalid GraphClientOptions before constructing the client", async () => {
    const { client } = createMockGraphClient({});
    const { GraphClient } = await import("../../src/auth/graph-client.js");

    // biome-ignore lint/suspicious/noExplicitAny: test mock doesn't need full Client interface
    expect(() => new GraphClient(client as any, "user@example.com", { qps: 0 })).toThrow(RangeError);
    // biome-ignore lint/suspicious/noExplicitAny: test mock doesn't need full Client interface
    expect(() => new GraphClient(client as any, "user@example.com", { maxRetries: -1 })).toThrow(RangeError);
    // biome-ignore lint/suspicious/noExplicitAny: test mock doesn't need full Client interface
    expect(() => new GraphClient(client as any, "user@example.com", { initialRetryDelayMs: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// listCategories, createCategory
// ---------------------------------------------------------------------------

describe("GraphClient.listCategories()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns categories from /users/{email}/outlook/masterCategories", async () => {
    const { client, builder } = createMockGraphClient({
      value: [
        { displayName: "_noise", color: "preset0" },
        { displayName: "_keep", color: "preset1" },
      ],
    });

    const gc = await createTestClient(client);
    const result = await gc.listCategories();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toHaveLength(2);
    expect(result.value[0]!.displayName).toBe("_noise");
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/outlook/masterCategories");
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });
});

describe("GraphClient.createCategory()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a category via POST", async () => {
    const { client, builder } = createMockGraphClient({ displayName: "_noise", color: "preset0" });

    const gc = await createTestClient(client);
    const result = await gc.createCategory("_noise", "preset0");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.displayName).toBe("_noise");
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/outlook/masterCategories");
    expect(builder.post).toHaveBeenCalledWith({ displayName: "_noise", color: "preset0" });
  });
});

// ---------------------------------------------------------------------------
// listRules, createRule, deleteRule
// ---------------------------------------------------------------------------

describe("GraphClient.listRules()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns inbox message rules", async () => {
    const { client, builder } = createMockGraphClient({
      value: [
        {
          id: "rule-1",
          displayName: "Move newsletters",
          conditions: { senderContains: ["newsletter"] },
          actions: { moveToFolder: "archive" },
          isEnabled: true,
        },
      ],
    });

    const gc = await createTestClient(client);
    const result = await gc.listRules();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toHaveLength(1);
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/mailFolders/inbox/messageRules");
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });
});

describe("GraphClient.createRule()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an inbox rule via POST", async () => {
    const rule = {
      displayName: "Auto-archive noise",
      conditions: { senderContains: ["noreply@"] },
      actions: { moveToFolder: "archive-id" },
      isEnabled: true,
    };
    const { client, builder } = createMockGraphClient({ id: "rule-new", ...rule });

    const gc = await createTestClient(client);
    const result = await gc.createRule(rule);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/mailFolders/inbox/messageRules");
    expect(builder.post).toHaveBeenCalledWith(rule);
  });
});

describe("GraphClient.deleteRule()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an inbox rule via DELETE", async () => {
    const { client, builder } = createMockGraphClient();
    builder.delete.mockResolvedValue(undefined);

    const gc = await createTestClient(client);
    const result = await gc.deleteRule("rule-123");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value).toBeUndefined();
    expect(client.api).toHaveBeenCalledWith("/users/user%40example.com/mailFolders/inbox/messageRules/rule-123");
    expect(builder.header).toHaveBeenCalledWith("Prefer", 'IdType="ImmutableId"');
  });

  it("returns error Result on API failure", async () => {
    const { client, builder } = createMockGraphClient();
    builder.delete.mockRejectedValue(Object.assign(new Error("Not Found"), { statusCode: 404 }));

    const gc = await createTestClient(client, { maxRetries: 0 });
    const result = await gc.deleteRule("nonexistent");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe("Not Found");
  });
});
