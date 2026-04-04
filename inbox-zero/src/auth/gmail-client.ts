/**
 * GmailClient — rate-limited, retry-aware wrapper around the Gmail v1 API.
 *
 * Design decisions:
 * - Uses `google.auth.getApplicationDefault()` to pick up gcloud credentials.
 * - Token-bucket rate limiter: configurable QPS (default 10).
 * - Exponential-backoff retry on 429 / 503 only; 4xx client errors are NOT retried.
 * - All public methods return `Result<T>` so callers never receive raw exceptions.
 */

import type { gmail_v1 } from "googleapis";
import { google } from "googleapis";

export type { Result } from "../types.js";

import type { Result } from "../types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GmailClientOptions {
  /** Queries per second. Defaults to 10. */
  qps?: number;
  /** Maximum retry attempts on retryable errors (429/503). Defaults to 5. */
  maxRetries?: number;
  /** Initial delay in ms before the first retry. Doubles each attempt. Defaults to 1000. */
  initialRetryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// GmailClient interface
// ---------------------------------------------------------------------------

export interface GmailClient {
  getProfile(): Promise<Result<{ emailAddress: string; messagesTotal: number }>>;

  listMessages(
    query: string,
    pageToken?: string,
    maxResults?: number,
  ): Promise<
    Result<{
      messages: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>
  >;

  getMessage(
    id: string,
    format?: "metadata" | "full",
    metadataHeaders?: string[],
  ): Promise<Result<gmail_v1.Schema$Message>>;

  batchModifyMessages(ids: string[], addLabelIds?: string[], removeLabelIds?: string[]): Promise<Result<void>>;

  listLabels(): Promise<Result<gmail_v1.Schema$Label[]>>;

  listFilters(): Promise<Result<gmail_v1.Schema$Filter[]>>;

  createLabel(name: string): Promise<Result<gmail_v1.Schema$Label>>;

  createFilter(
    criteria: { from?: string; query?: string },
    action: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<Result<gmail_v1.Schema$Filter>>;

  deleteFilter(filterId: string): Promise<Result<void>>;
}

// ---------------------------------------------------------------------------
// Retryable error codes
// ---------------------------------------------------------------------------

/** HTTP status codes that should trigger a retry. */
const RETRYABLE_CODES = new Set([429, 503]);

function isRetryable(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const code = (err as Record<string, unknown>)["code"];
    if (typeof code === "number") return RETRYABLE_CODES.has(code);
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Token-bucket rate limiter
// ---------------------------------------------------------------------------

/**
 * Simple token-bucket limiter that gates async work to at most `qps` calls
 * per second.
 *
 * Implementation: we track how many tokens have been used in the current
 * 1-second window. When the bucket is full we wait until the window resets.
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

  /**
   * Waits until a token is available, then resolves.
   */
  async acquire(): Promise<void> {
    const now = Date.now();

    if (now >= this.windowEnd) {
      // Start a new window.
      this.windowCount = 0;
      this.windowEnd = now + 1000;
    }

    if (this.windowCount < this.qps) {
      this.windowCount++;
      return;
    }

    // Window exhausted — wait until it resets.
    const delay = this.windowEnd - Date.now();
    await sleep(delay > 0 ? delay : 0);

    // Re-acquire in the new window.
    this.windowCount = 0;
    this.windowEnd = Date.now() + 1000;
    this.windowCount++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core GmailClient implementation
// ---------------------------------------------------------------------------

class GmailClientImpl implements GmailClient {
  private readonly api: gmail_v1.Gmail;
  private readonly limiter: TokenBucketLimiter;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;

  constructor(api: gmail_v1.Gmail, options: Required<GmailClientOptions>) {
    this.api = api;
    this.limiter = new TokenBucketLimiter(options.qps);
    this.maxRetries = options.maxRetries;
    this.initialRetryDelayMs = options.initialRetryDelayMs;
  }

  /**
   * Wraps an API call with rate limiting and retry logic.
   * Returns a `Result<T>`.
   */
  private async call<T>(fn: () => Promise<T>): Promise<Result<T>> {
    let attempt = 0;
    let delayMs = this.initialRetryDelayMs;

    while (true) {
      await this.limiter.acquire();

      try {
        const value = await fn();
        return { ok: true, value };
      } catch (err: unknown) {
        if (!isRetryable(err) || attempt >= this.maxRetries) {
          return { ok: false, error: errorMessage(err) };
        }

        attempt++;
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
  }

  async getProfile(): Promise<Result<{ emailAddress: string; messagesTotal: number }>> {
    const result = await this.call(() => this.api.users.getProfile({ userId: "me" }));

    if (!result.ok) return result;

    const profile = result.value.data;
    const emailAddress = profile.emailAddress ?? "";
    const messagesTotal = profile.messagesTotal ?? 0;

    return { ok: true, value: { emailAddress, messagesTotal } };
  }

  async listMessages(
    query: string,
    pageToken?: string,
    maxResults?: number,
  ): Promise<
    Result<{
      messages: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>
  > {
    const params: gmail_v1.Params$Resource$Users$Messages$List = {
      userId: "me",
      q: query,
    };

    if (pageToken !== undefined) params.pageToken = pageToken;
    if (maxResults !== undefined) params.maxResults = maxResults;

    const result = await this.call(() => this.api.users.messages.list(params));

    if (!result.ok) return result;

    const rawMessages = result.value.data.messages ?? [];
    const messages = rawMessages.map((m) => ({
      id: m.id ?? "",
      threadId: m.threadId ?? "",
    }));

    return {
      ok: true,
      value: {
        messages,
        nextPageToken: result.value.data.nextPageToken ?? undefined,
        resultSizeEstimate: result.value.data.resultSizeEstimate ?? undefined,
      },
    };
  }

  async getMessage(
    id: string,
    format?: "metadata" | "full",
    metadataHeaders?: string[],
  ): Promise<Result<gmail_v1.Schema$Message>> {
    const params: gmail_v1.Params$Resource$Users$Messages$Get = {
      userId: "me",
      id,
    };

    if (format !== undefined) params.format = format;
    if (metadataHeaders !== undefined) params.metadataHeaders = metadataHeaders;

    const result = await this.call(() => this.api.users.messages.get(params));

    if (!result.ok) return result;

    return { ok: true, value: result.value.data };
  }

  async batchModifyMessages(ids: string[], addLabelIds?: string[], removeLabelIds?: string[]): Promise<Result<void>> {
    const requestBody: gmail_v1.Schema$BatchModifyMessagesRequest = { ids };

    if (addLabelIds !== undefined) requestBody.addLabelIds = addLabelIds;
    if (removeLabelIds !== undefined) requestBody.removeLabelIds = removeLabelIds;

    const result = await this.call(() => this.api.users.messages.batchModify({ userId: "me", requestBody }));

    if (!result.ok) return result;

    return { ok: true, value: undefined };
  }

  async listLabels(): Promise<Result<gmail_v1.Schema$Label[]>> {
    const result = await this.call(() => this.api.users.labels.list({ userId: "me" }));

    if (!result.ok) return result;

    return { ok: true, value: result.value.data.labels ?? [] };
  }

  async listFilters(): Promise<Result<gmail_v1.Schema$Filter[]>> {
    const result = await this.call(() => this.api.users.settings.filters.list({ userId: "me" }));

    if (!result.ok) return result;

    return { ok: true, value: result.value.data.filter ?? [] };
  }

  async createLabel(name: string): Promise<Result<gmail_v1.Schema$Label>> {
    const result = await this.call(() =>
      this.api.users.labels.create({
        userId: "me",
        requestBody: { name },
      }),
    );

    if (!result.ok) return result;

    return { ok: true, value: result.value.data };
  }

  async createFilter(
    criteria: { from?: string; query?: string },
    action: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<Result<gmail_v1.Schema$Filter>> {
    const result = await this.call(() =>
      this.api.users.settings.filters.create({
        userId: "me",
        requestBody: { criteria, action },
      }),
    );

    if (!result.ok) return result;

    return { ok: true, value: result.value.data };
  }

  async deleteFilter(filterId: string): Promise<Result<void>> {
    const result = await this.call(() =>
      this.api.users.settings.filters.delete({
        userId: "me",
        id: filterId,
      }),
    );

    if (!result.ok) return result;

    return { ok: true, value: undefined };
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a `GmailClient` authenticated via Application Default Credentials.
 *
 * @example
 * ```ts
 * const client = await createGmailClient();
 * const profile = await client.getProfile();
 * if (profile.ok) console.log(profile.value.emailAddress);
 * ```
 */
export async function createGmailClient(options: GmailClientOptions = {}): Promise<GmailClient> {
  const resolvedOptions: Required<GmailClientOptions> = {
    qps: options.qps ?? 40,
    maxRetries: options.maxRetries ?? 5,
    initialRetryDelayMs: options.initialRetryDelayMs ?? 1000,
  };

  const GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
  ];

  const keyFile = process.env["GOOGLE_SERVICE_ACCOUNT_KEY"];
  const impersonateUser = process.env["GMAIL_USER"];

  let auth: InstanceType<typeof google.auth.GoogleAuth>;
  if (keyFile !== undefined && keyFile.length > 0) {
    if (!impersonateUser) {
      throw new Error("GMAIL_USER is required when GOOGLE_SERVICE_ACCOUNT_KEY is set");
    }

    // Service account with domain-wide delegation — bypasses RAPT token expiry
    auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: GMAIL_SCOPES,
      clientOptions: { subject: impersonateUser },
    });
  } else {
    // Application Default Credentials (gcloud auth)
    auth = new google.auth.GoogleAuth({
      scopes: GMAIL_SCOPES,
    });
  }

  const api = google.gmail({
    version: "v1",
    auth,
  });

  return new GmailClientImpl(api, resolvedOptions);
}
