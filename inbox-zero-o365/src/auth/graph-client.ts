/**
 * GraphClient — rate-limited, retry-aware wrapper around the Microsoft Graph v1.0 API.
 *
 * Design decisions:
 * - Uses `ClientSecretCredential` + `TokenCredentialAuthenticationProvider` for daemon auth.
 * - Token-bucket rate limiter: 15 QPS (Microsoft Graph safe threshold).
 * - Exponential-backoff retry on 429 / 503 only; 4xx client errors are NOT retried.
 * - All public methods return `Result<T>` so callers never receive raw exceptions.
 * - `Prefer: IdType="ImmutableId"` header on every request for stable message IDs.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { Result } from "../types.js";
import { chunkArray, GRAPH_BATCH_CHUNK_SIZE, Semaphore, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Mailbox profile returned by getProfile(). */
export interface GraphClientProfile {
  emailAddress: string;
  displayName: string;
}

/** Mail folder metadata returned by listFolders(). */
export interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
  parentFolderId?: string;
  childFolderCount?: number;
}

/** Message metadata returned by listMessages() and getMessage(). */
export interface GraphMessage {
  id: string;
  conversationId: string;
  from?: { emailAddress: { address: string; name: string } };
  toRecipients: Array<{ emailAddress: { address: string; name: string } }>;
  ccRecipients: Array<{ emailAddress: { address: string; name: string } }>;
  subject: string;
  receivedDateTime: string;
  categories: string[];
  isRead: boolean;
  parentFolderId: string;
  bodyPreview: string;
  flag: { flagStatus: string };
  importance: string;
}

/** Inbox message rule. */
export interface GraphRule {
  id?: string;
  displayName: string;
  sequence?: number;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
  isEnabled: boolean;
}

export interface GraphMutationFailure {
  messageId: string;
  error: string;
  statusCode?: number;
  code?: string;
  kind: "not_found" | "other";
}

interface GraphMutationSummary {
  succeeded: number;
  errors: number;
  failures: GraphMutationFailure[];
}

/** Options for listMessages(). */
export interface ListMessagesOptions {
  top?: number;
  select?: string[];
  filter?: string;
  orderby?: string;
  skipToken?: string;
}

/** Options for GraphClient constructor. */
export interface GraphClientOptions {
  /** Queries per second. Defaults to 15. */
  qps?: number;
  /** Maximum retry attempts on retryable errors (429/503). Defaults to 5. */
  maxRetries?: number;
  /** Initial delay in ms before the first retry. Doubles each attempt. Defaults to 1000. */
  initialRetryDelayMs?: number;
}

interface CallOptions {
  allowRetry?: boolean;
}

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

/** HTTP status codes that should trigger a retry. */
const RETRYABLE_CODES = new Set([429, 503]);

/** Graph SDK errors may have `statusCode` or `code` as the HTTP status. */
function isRetryable(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const statusCode = (err as Record<string, unknown>)["statusCode"];
    if (typeof statusCode === "number") return RETRYABLE_CODES.has(statusCode);
    const code = (err as Record<string, unknown>)["code"];
    if (typeof code === "number") return RETRYABLE_CODES.has(code);
  }
  return false;
}

function extractGraphErrorInfo(err: unknown): Omit<GraphMutationFailure, "messageId"> {
  let statusCode: number | undefined;
  let code: string | undefined;

  if (err !== null && typeof err === "object") {
    const statusCodeValue = (err as Record<string, unknown>)["statusCode"];
    if (typeof statusCodeValue === "number") {
      statusCode = statusCodeValue;
    }

    const codeValue = (err as Record<string, unknown>)["code"];
    if (typeof codeValue === "string") {
      code = codeValue;
    } else if (typeof codeValue === "number") {
      code = String(codeValue);
    }
  }

  const error = toErrorMessage(err);
  const lowerCode = code?.toLowerCase() ?? "";
  const lowerError = error.toLowerCase();
  const kind =
    statusCode === 404 ||
    lowerCode.includes("notfound") ||
    lowerCode.includes("itemnotfound") ||
    lowerError.includes("not found")
      ? "not_found"
      : "other";

  return { error, statusCode, code, kind };
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter
// ---------------------------------------------------------------------------

/**
 * Simple token-bucket limiter that gates async work to at most `qps` calls
 * per second.
 */
class TokenBucketLimiter {
  private readonly qps: number;
  /** Count of calls dispatched in the current window. */
  private windowCount = 0;
  /** When the current window expires (ms since epoch). */
  private windowEnd = 0;

  constructor(qps: number) {
    this.qps = qps;
  }

  /** Waits until a token is available, then resolves. */
  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();

      if (now >= this.windowEnd) {
        this.windowCount = 0;
        this.windowEnd = now + 1000;
      }

      if (this.windowCount < this.qps) {
        this.windowCount++;
        return;
      }

      await sleep(Math.max(this.windowEnd - now, 0));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Immutable ID header constant
// ---------------------------------------------------------------------------

/** Header key/value to ensure Graph returns immutable IDs. */
const IMMUTABLE_ID_HEADER_KEY = "Prefer";
const IMMUTABLE_ID_HEADER_VALUE = 'IdType="ImmutableId"';

// ---------------------------------------------------------------------------
// GraphClient implementation
// ---------------------------------------------------------------------------

/** Default QPS for Graph API requests. */
const DEFAULT_QPS = 15;
/** Default maximum retries. */
const DEFAULT_MAX_RETRIES = 5;
/** Default initial retry delay in milliseconds. */
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1000;
/** Expected origin for absolute Graph pagination URLs. */
const GRAPH_API_ORIGIN = "https://graph.microsoft.com";

function userApiPath(userEmail: string, suffix = ""): string {
  return `/users/${encodeURIComponent(userEmail)}${suffix}`;
}

/**
 * Rate-limited, retry-aware Microsoft Graph API client.
 *
 * All public methods return `Result<T>` — callers never receive raw exceptions.
 * Every request includes the `Prefer: IdType="ImmutableId"` header.
 */
export class GraphClient {
  private readonly client: Client;
  private readonly userEmail: string;
  private readonly limiter: TokenBucketLimiter;
  private readonly concurrency: Semaphore;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;

  constructor(client: Client, userEmail: string, options?: GraphClientOptions) {
    const qps = options?.qps ?? DEFAULT_QPS;
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialRetryDelayMs = options?.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;

    if (!Number.isInteger(qps) || qps <= 0) {
      throw new RangeError("GraphClient: qps must be a positive integer");
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("GraphClient: maxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(initialRetryDelayMs) || initialRetryDelayMs <= 0) {
      throw new RangeError("GraphClient: initialRetryDelayMs must be positive");
    }

    this.client = client;
    this.userEmail = userEmail;
    this.limiter = new TokenBucketLimiter(qps);
    this.concurrency = new Semaphore(GRAPH_BATCH_CHUNK_SIZE);
    this.maxRetries = maxRetries;
    this.initialRetryDelayMs = initialRetryDelayMs;
  }

  // -------------------------------------------------------------------------
  // Private: rate-limited, retryable call wrapper
  // -------------------------------------------------------------------------

  /**
   * Wraps an API call with rate limiting and exponential-backoff retry logic.
   * Returns a `Result<T>`.
   */
  private async call<T>(fn: () => Promise<T>, options: CallOptions = {}): Promise<Result<T>> {
    const allowRetry = options.allowRetry ?? true;
    let attempt = 0;
    let delayMs = this.initialRetryDelayMs;

    while (true) {
      await this.limiter.acquire();

      try {
        const value = await fn();
        return { ok: true, value };
      } catch (err: unknown) {
        if (!allowRetry || !isRetryable(err) || attempt >= this.maxRetries) {
          return { ok: false, error: toErrorMessage(err) };
        }

        attempt++;
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
  }

  /**
   * Returns a Graph SDK request builder pre-configured with the immutable ID header.
   * All public methods should use this instead of calling `this.client.api()` directly.
   */
  private api(path: string) {
    return this.client.api(path).header(IMMUTABLE_ID_HEADER_KEY, IMMUTABLE_ID_HEADER_VALUE);
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  /** GET /users/{email} — returns mailbox identity. */
  async getProfile(): Promise<Result<GraphClientProfile>> {
    const result = await this.call(() =>
      this.api(userApiPath(this.userEmail)).select(["displayName", "mail", "userPrincipalName"]).get(),
    );

    if (!result.ok) return result;

    const data = result.value as Record<string, unknown>;
    const emailAddress =
      (data["mail"] as string | undefined) ?? (data["userPrincipalName"] as string | undefined) ?? "";
    const displayName = (data["displayName"] as string | undefined) ?? "";

    return { ok: true, value: { emailAddress, displayName } };
  }

  /**
   * Recursively loads all top-level folders and child folders in the mailbox.
   * Uses $select for id, displayName, totalItemCount, unreadItemCount,
   * parentFolderId, and childFolderCount.
   */
  async listFolders(): Promise<Result<GraphFolder[]>> {
    /** Maximum collection pages to follow to prevent runaway pagination. */
    const MAX_PAGES = 500;
    const folders: GraphFolder[] = [];
    const seenFolderIds = new Set<string>();
    const pendingCollections: string[] = [userApiPath(this.userEmail, "/mailFolders")];
    let pagesFetched = 0;
    let truncated = false;

    while (pendingCollections.length > 0 && pagesFetched < MAX_PAGES) {
      let collectionRef = pendingCollections.shift();

      while (collectionRef !== undefined && pagesFetched < MAX_PAGES) {
        const pageResult = await this.call(() => {
          let req = this.api(collectionRef!);

          // Only apply select/top on first-party collection paths. OData nextLinks
          // already encode their own query parameters.
          if (!collectionRef!.startsWith("http")) {
            req = req
              .select(["id", "displayName", "totalItemCount", "unreadItemCount", "parentFolderId", "childFolderCount"])
              .top(100);
          }

          return req.get();
        });

        if (!pageResult.ok) return pageResult;

        const pageData = pageResult.value as { value?: unknown[]; "@odata.nextLink"?: string };
        if (Array.isArray(pageData.value)) {
          for (const raw of pageData.value) {
            const folder = toGraphFolder(raw);
            if (seenFolderIds.has(folder.id)) {
              continue;
            }

            seenFolderIds.add(folder.id);
            folders.push(folder);

            if ((folder.childFolderCount ?? 0) > 0) {
              pendingCollections.push(
                userApiPath(this.userEmail, `/mailFolders/${encodeURIComponent(folder.id)}/childFolders`),
              );
            }
          }
        }

        collectionRef = pageData["@odata.nextLink"];
        pagesFetched++;
      }

      if (collectionRef !== undefined) {
        truncated = true;
        break;
      }
    }

    if (truncated || pendingCollections.length > 0) {
      return { ok: false, error: `Exceeded MAX_PAGES (${MAX_PAGES}) while listing folders` };
    }

    return { ok: true, value: folders };
  }

  /** GET /users/{email}/mailFolders/{wellKnownName} — returns a specific default folder. */
  async getMailFolder(folderIdOrWellKnownName: string): Promise<Result<GraphFolder>> {
    const result = await this.call(() =>
      this.api(userApiPath(this.userEmail, `/mailFolders/${encodeURIComponent(folderIdOrWellKnownName)}`))
        .select(["id", "displayName", "totalItemCount", "unreadItemCount", "parentFolderId", "childFolderCount"])
        .get(),
    );

    if (!result.ok) return result;
    return { ok: true, value: toGraphFolder(result.value) };
  }

  /**
   * GET /users/{email}/messages — list messages with optional $top, $select, $filter, $skipToken.
   * Returns messages and optional @odata.nextLink for the caller to manage pagination.
   */
  async listMessages(options: ListMessagesOptions): Promise<Result<{ messages: GraphMessage[]; nextLink?: string }>> {
    const result = await this.call(() => {
      let req = this.api(userApiPath(this.userEmail, "/messages"));

      if (options.select !== undefined) req = req.select(options.select);
      if (options.top !== undefined) req = req.top(options.top);
      if (options.filter !== undefined) req = req.filter(options.filter);
      if (options.orderby !== undefined) req = req.orderby(options.orderby);
      if (options.skipToken !== undefined) req = req.skipToken(options.skipToken);

      return req.get();
    });

    if (!result.ok) return result;

    const data = result.value as { value?: unknown[]; "@odata.nextLink"?: string };
    const messages = Array.isArray(data.value) ? data.value.map(toGraphMessage) : [];
    const nextLink = data["@odata.nextLink"];

    return { ok: true, value: { messages, nextLink } };
  }

  /**
   * Follow an @odata.nextLink URL to retrieve the next page of messages.
   * Used by the metadata puller for resumable pagination.
   */
  async followNextLink(nextLinkUrl: string): Promise<Result<{ messages: GraphMessage[]; nextLink?: string }>> {
    let validatedNextLink: URL;
    try {
      validatedNextLink = new URL(nextLinkUrl);
    } catch {
      return { ok: false, error: `Invalid nextLink URL: ${nextLinkUrl}` };
    }

    if (validatedNextLink.origin !== GRAPH_API_ORIGIN) {
      return { ok: false, error: `Invalid nextLink origin: ${validatedNextLink.origin}` };
    }

    let pathSegments: string[];
    try {
      pathSegments = validatedNextLink.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return { ok: false, error: `Invalid nextLink path: ${validatedNextLink.pathname}` };
    }

    const expectedPath =
      pathSegments.length === 4 &&
      pathSegments[0] === "v1.0" &&
      pathSegments[1] === "users" &&
      pathSegments[2]?.toLowerCase() === this.userEmail.toLowerCase() &&
      pathSegments[3] === "messages";
    if (!expectedPath) {
      return { ok: false, error: `Invalid nextLink path: ${validatedNextLink.pathname}` };
    }

    const result = await this.call(() => this.api(validatedNextLink.toString()).get());

    if (!result.ok) return result;

    const data = result.value as { value?: unknown[]; "@odata.nextLink"?: string };
    const messages = Array.isArray(data.value) ? data.value.map(toGraphMessage) : [];
    const nextLink = data["@odata.nextLink"];

    return { ok: true, value: { messages, nextLink } };
  }

  /** GET /users/{email}/messages/{id} — retrieve a single message by immutable ID. */
  async getMessage(id: string): Promise<Result<GraphMessage>> {
    const result = await this.call(() =>
      this.api(userApiPath(this.userEmail, `/messages/${encodeURIComponent(id)}`)).get(),
    );

    if (!result.ok) return result;

    return { ok: true, value: toGraphMessage(result.value) };
  }

  /**
   * Shared bulk mutation helper — chunks message IDs, runs each through a
   * per-message callback with bounded concurrency, counts successes/errors.
   * Mutations are NOT retried (allowRetry: false) to prevent duplicate side effects.
   */
  private async bulkMutate(
    messageIds: string[],
    fn: (msgId: string) => Promise<unknown>,
  ): Promise<Result<GraphMutationSummary>> {
    let succeeded = 0;
    let errors = 0;
    const failures: GraphMutationFailure[] = [];

    for (const chunk of chunkArray(messageIds, GRAPH_BATCH_CHUNK_SIZE)) {
      const results = await Promise.all(
        chunk.map(async (msgId) => {
          await this.concurrency.acquire();
          try {
            await this.limiter.acquire();
            try {
              await fn(msgId);
              return { ok: true as const };
            } catch (err: unknown) {
              return {
                ok: false as const,
                failure: { messageId: msgId, ...extractGraphErrorInfo(err) },
              };
            }
          } finally {
            this.concurrency.release();
          }
        }),
      );

      for (const r of results) {
        if (r.ok) {
          succeeded++;
        } else {
          errors++;
          failures.push(r.failure);
        }
      }
    }

    return { ok: true, value: { succeeded, errors, failures } };
  }

  /**
   * POST /users/{email}/messages/{id}/move for each message.
   * Chunked by GRAPH_BATCH_CHUNK_SIZE (20) with bounded concurrency.
   */
  async moveMessages(
    messageIds: string[],
    destinationFolderId: string,
  ): Promise<Result<{ moved: number; errors: number; failures: GraphMutationFailure[] }>> {
    const result = await this.bulkMutate(messageIds, (msgId) =>
      this.api(userApiPath(this.userEmail, `/messages/${encodeURIComponent(msgId)}/move`)).post({
        destinationId: destinationFolderId,
      }),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: { moved: result.value.succeeded, errors: result.value.errors, failures: result.value.failures },
    };
  }

  /**
   * PATCH /users/{email}/messages/{id} for each message.
   * Chunked by GRAPH_BATCH_CHUNK_SIZE (20) with bounded concurrency.
   * Used primarily for adding categories.
   */
  async patchMessages(
    messageIds: string[],
    patch: Record<string, unknown>,
  ): Promise<Result<{ patched: number; errors: number; failures: GraphMutationFailure[] }>> {
    const result = await this.bulkMutate(messageIds, (msgId) =>
      this.api(userApiPath(this.userEmail, `/messages/${encodeURIComponent(msgId)}`)).patch(patch),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: { patched: result.value.succeeded, errors: result.value.errors, failures: result.value.failures },
    };
  }

  /** GET /users/{email}/outlook/masterCategories — returns all Outlook categories. */
  async listCategories(): Promise<Result<Array<{ displayName: string; color: string }>>> {
    const result = await this.call(() => this.api(userApiPath(this.userEmail, "/outlook/masterCategories")).get());

    if (!result.ok) return result;

    const data = result.value as { value?: Array<{ displayName: string; color: string }> };
    return { ok: true, value: data.value ?? [] };
  }

  /** POST /users/{email}/outlook/masterCategories — creates a new category. */
  async createCategory(displayName: string, color: string): Promise<Result<{ displayName: string }>> {
    const result = await this.call(
      () => this.api(userApiPath(this.userEmail, "/outlook/masterCategories")).post({ displayName, color }),
      { allowRetry: false },
    );

    if (!result.ok) return result;

    const data = result.value as { displayName: string };
    return { ok: true, value: { displayName: data.displayName } };
  }

  /** GET /users/{email}/mailFolders/inbox/messageRules — returns all inbox rules. */
  async listRules(): Promise<Result<GraphRule[]>> {
    const result = await this.call(() =>
      this.api(userApiPath(this.userEmail, "/mailFolders/inbox/messageRules")).get(),
    );

    if (!result.ok) return result;

    const data = result.value as { value?: GraphRule[] };
    return { ok: true, value: data.value ?? [] };
  }

  /** POST /users/{email}/mailFolders/inbox/messageRules — creates an inbox rule. */
  async createRule(rule: Omit<GraphRule, "id">): Promise<Result<GraphRule>> {
    const result = await this.call(
      () => this.api(userApiPath(this.userEmail, "/mailFolders/inbox/messageRules")).post(rule),
      { allowRetry: false },
    );

    if (!result.ok) return result;

    return { ok: true, value: result.value as GraphRule };
  }

  /** DELETE /users/{email}/mailFolders/inbox/messageRules/{ruleId} — deletes an inbox rule. */
  async deleteRule(ruleId: string): Promise<Result<void>> {
    const result = await this.call(
      () =>
        this.api(userApiPath(this.userEmail, `/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`)).delete(),
      { allowRetry: false },
    );

    if (!result.ok) return result;

    return { ok: true, value: undefined };
  }
}

// ---------------------------------------------------------------------------
// Helper: convert raw Graph API folder response to GraphFolder
// ---------------------------------------------------------------------------

function toGraphFolder(raw: unknown): GraphFolder {
  const obj = raw as Record<string, unknown>;
  return {
    id: (obj["id"] as string | undefined) ?? "",
    displayName: (obj["displayName"] as string | undefined) ?? "",
    totalItemCount: (obj["totalItemCount"] as number | undefined) ?? 0,
    unreadItemCount: (obj["unreadItemCount"] as number | undefined) ?? 0,
    parentFolderId: obj["parentFolderId"] as string | undefined,
    childFolderCount: (obj["childFolderCount"] as number | undefined) ?? 0,
  };
}

function toGraphRecipient(raw: unknown): { emailAddress: { address: string; name: string } } {
  const obj = raw as Record<string, unknown>;
  const emailAddress = obj["emailAddress"] as Record<string, unknown> | undefined;
  return {
    emailAddress: {
      address: (emailAddress?.["address"] as string | undefined) ?? "",
      name: (emailAddress?.["name"] as string | undefined) ?? "",
    },
  };
}

function toGraphMessage(raw: unknown): GraphMessage {
  const obj = raw as Record<string, unknown>;
  const fromRaw = obj["from"];
  const toRecipientsRaw = obj["toRecipients"];
  const ccRecipientsRaw = obj["ccRecipients"];
  const categoriesRaw = obj["categories"];
  const flagRaw = obj["flag"] as Record<string, unknown> | undefined;

  return {
    id: (obj["id"] as string | undefined) ?? "",
    conversationId:
      typeof obj["conversationId"] === "string" && obj["conversationId"].length > 0
        ? obj["conversationId"]
        : ((obj["id"] as string | undefined) ?? ""),
    from: fromRaw !== undefined && fromRaw !== null ? toGraphRecipient(fromRaw) : undefined,
    toRecipients: Array.isArray(toRecipientsRaw) ? toRecipientsRaw.map(toGraphRecipient) : [],
    ccRecipients: Array.isArray(ccRecipientsRaw) ? ccRecipientsRaw.map(toGraphRecipient) : [],
    subject: (obj["subject"] as string | undefined) ?? "",
    receivedDateTime: (obj["receivedDateTime"] as string | undefined) ?? "",
    categories: Array.isArray(categoriesRaw)
      ? categoriesRaw.filter((value): value is string => typeof value === "string")
      : [],
    isRead: obj["isRead"] === true,
    parentFolderId: (obj["parentFolderId"] as string | undefined) ?? "",
    bodyPreview: (obj["bodyPreview"] as string | undefined) ?? "",
    flag: {
      flagStatus: (flagRaw?.["flagStatus"] as string | undefined) ?? "",
    },
    importance: (obj["importance"] as string | undefined) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Factory function: createGraphClient
// ---------------------------------------------------------------------------

/**
 * Creates a `GraphClient` authenticated via Azure AD client credentials.
 *
 * Required environment variables:
 * - `O365_TENANT_ID` — Azure AD tenant ID
 * - `O365_CLIENT_ID` — App registration client ID
 * - `O365_CLIENT_SECRET` — App registration client secret
 * - `O365_USER_EMAIL` — Target mailbox email address
 *
 * @example
 * ```ts
 * const client = await createGraphClient();
 * const profile = await client.getProfile();
 * if (profile.ok) console.log(profile.value.emailAddress);
 * ```
 */
export async function createGraphClient(): Promise<GraphClient> {
  // Dynamic imports so that the module can be tested without real credentials.
  const { ClientSecretCredential } = await import("@azure/identity");
  const { Client: GraphSdkClient } = await import("@microsoft/microsoft-graph-client");
  const { TokenCredentialAuthenticationProvider } = await import(
    "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js"
  );

  const readRequiredEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const tenantId = readRequiredEnv("O365_TENANT_ID");
  const clientId = readRequiredEnv("O365_CLIENT_ID");
  const clientSecret = readRequiredEnv("O365_CLIENT_SECRET");
  const userEmail = readRequiredEnv("O365_USER_EMAIL");

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });
  const client = GraphSdkClient.initWithMiddleware({ authProvider });

  return new GraphClient(client, userEmail);
}
