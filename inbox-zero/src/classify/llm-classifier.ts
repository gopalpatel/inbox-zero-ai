/**
 * llm-classifier.ts
 *
 * Provider-agnostic LLM classifier for email threads.
 *
 * Design decisions:
 * - ClassificationProvider interface decouples business logic from SDK details.
 * - Semaphore pattern bounds concurrent API requests (ReDoS / rate-limit guard).
 * - 12-month actionable window: enforced in classifyBatch, not delegated to the LLM.
 * - All JSON.parse() calls are wrapped in try/catch.
 * - Never logs API keys or sensitive credentials.
 * - Batch size safety limit: MAX_BATCH_SIZE guards against unbounded loops.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ThreadClassification } from "../schemas/classification.js";
import { ThreadClassificationSchema } from "../schemas/classification.js";
import type { Result } from "../types.js";
import { Semaphore, TWELVE_MONTHS_MS, toErrorMessage } from "../utils.js";
import type { ThreadSummary } from "./thread-collapser.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default model for bulk classification — cost-efficient Haiku variant. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** Default maximum concurrent provider requests. */
const DEFAULT_MAX_CONCURRENT = 5;

/** Maximum threads processed in a single classifyBatch call (safety limit). */
const MAX_BATCH_SIZE = 10_000;

/** Maximum threads sampled for taxonomy proposal. */
const MAX_TAXONOMY_SAMPLE = 1_000;

// TWELVE_MONTHS_MS imported from ../utils.js

// ---------------------------------------------------------------------------
// ClassificationProvider interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for LLM classification.
 * Implement this to swap out the underlying AI SDK without changing callers.
 */
export interface ClassificationProvider {
  /**
   * Classify a single email thread's content.
   *
   * @param content           The thread's text content.
   * @param existingCategories  Categories already in use — LLM should prefer these.
   * @param threadId          Thread ID to include in the classification result.
   * @returns Result containing ThreadClassification or an error string.
   */
  classify(content: string, existingCategories: string[], threadId: string): Promise<Result<ThreadClassification>>;

  /**
   * Propose 5–15 category names based on a representative sample of content.
   *
   * @param sampleContent  Array of thread content strings.
   * @returns Result containing an array of suggested category name strings.
   */
  proposeTaxonomy(sampleContent: string[]): Promise<Result<string[]>>;
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

/**
 * ClassificationProvider implementation backed by the Anthropic SDK.
 *
 * Constructor options:
 * - `apiKey`  — Anthropic API key (never logged).
 * - `model`   — Optional model ID; defaults to DEFAULT_MODEL.
 */
export class AnthropicProvider implements ClassificationProvider {
  /** Anthropic model ID used for all requests. */
  readonly model: string;

  /** @internal Anthropic SDK client — replaceable in tests. */
  client: Pick<Anthropic, "messages">;

  constructor(options: { apiKey: string; model?: string }) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  /**
   * Classify a single thread using the Anthropic Messages API.
   * Returns `{ ok: false }` on SDK errors or invalid response shapes.
   */
  async classify(
    content: string,
    existingCategories: string[],
    threadId: string,
  ): Promise<Result<ThreadClassification>> {
    const categoryList =
      existingCategories.length > 0 ? existingCategories.join(", ") : "(none yet — suggest a new category name)";

    const prompt =
      `Classify this email thread. Return JSON with fields: ` +
      `category (from approved list or suggest new), ` +
      `confidence (0-1), actionable (true if needs human response), ` +
      `summary (1-2 sentences). ` +
      `Existing categories: ${categoryList}. ` +
      `Thread ID: ${threadId}. ` +
      `Return ONLY valid JSON matching this schema: ` +
      `{"threadId":"string","category":"string","confidence":number,"actionable":boolean,"summary":"string","classifiedBy":"llm"}. ` +
      `\n\nEmail thread content:\n${content}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock === undefined || textBlock.type !== "text") {
        return { ok: false, error: "Invalid LLM response: no text block" };
      }

      const rawText = textBlock.text.trim();

      // Extract JSON from the response (model may wrap it in markdown fences).
      const jsonText = extractJson(rawText);
      if (jsonText === null) {
        return { ok: false, error: "Invalid LLM response: no JSON found" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return { ok: false, error: "Invalid LLM response: JSON parse failed" };
      }

      const result = ThreadClassificationSchema.safeParse(parsed);
      if (!result.success) {
        return { ok: false, error: "Invalid LLM response: schema validation failed" };
      }

      return { ok: true, value: result.data };
    } catch (err) {
      return { ok: false, error: `Provider error: ${toErrorMessage(err)}` };
    }
  }

  /**
   * Ask the LLM to propose 5–15 category names from a sample of thread content.
   * Returns `{ ok: false }` on SDK errors or unexpected response shapes.
   */
  async proposeTaxonomy(sampleContent: string[]): Promise<Result<string[]>> {
    const joined = sampleContent.slice(0, MAX_TAXONOMY_SAMPLE).join("\n---\n");

    const prompt =
      `You are analyzing a collection of email threads to identify natural groupings. ` +
      `Based on the content patterns below, propose 5-15 concise category names ` +
      `that would meaningfully organise these emails. ` +
      `Return ONLY a JSON array of strings, e.g. ["newsletter","transactional","personal"]. ` +
      `\n\nEmail content samples:\n${joined}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock === undefined || textBlock.type !== "text") {
        return { ok: false, error: "Invalid LLM response: no text block" };
      }

      const rawText = textBlock.text.trim();
      const jsonText = extractJson(rawText);
      if (jsonText === null) {
        return { ok: false, error: "Invalid LLM response: no JSON found" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return { ok: false, error: "Invalid LLM response: JSON parse failed" };
      }

      const result = z.array(z.string().min(1)).safeParse(parsed);
      if (!result.success) {
        return { ok: false, error: "Invalid LLM response: expected string array" };
      }

      return { ok: true, value: result.data };
    } catch (err) {
      return { ok: false, error: `Provider error: ${toErrorMessage(err)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// classifyBatch
// ---------------------------------------------------------------------------

/** Options for classifyBatch. */
export interface ClassifyBatchOptions {
  /** Maximum number of concurrent provider requests. Defaults to 5. */
  maxConcurrent?: number;
}

/**
 * Classifies an array of threads in parallel, bounded by a Semaphore.
 *
 * - Threads with provider failures are returned as `uncategorized` (confidence 0).
 * - The `actionable` flag is forced to `false` for threads whose last message
 *   is older than 12 months, regardless of what the provider returns.
 * - All results have `classifiedBy: "llm"`.
 *
 * @param threads             Array of ThreadSummary to classify.
 * @param provider            ClassificationProvider implementation.
 * @param existingCategories  Category labels to pass to the provider.
 * @param options             Optional configuration (maxConcurrent).
 * @returns Array of ThreadClassification in the same length as input.
 */
export async function classifyBatch(
  threads: ThreadSummary[],
  provider: ClassificationProvider,
  existingCategories: string[],
  options: ClassifyBatchOptions = {},
): Promise<ThreadClassification[]> {
  if (threads.length === 0) return [];

  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const semaphore = new Semaphore(maxConcurrent);

  // Safety limit — bounded loop guard.
  const safeThreads = threads.slice(0, MAX_BATCH_SIZE);

  const now = new Date();

  const tasks = safeThreads.map((thread) =>
    (async (): Promise<ThreadClassification> => {
      await semaphore.acquire();
      try {
        const result = await provider.classify(thread.content, existingCategories, thread.threadId);

        if (!result.ok) {
          return buildFallback(thread.threadId);
        }

        const classification = result.value;

        // Enforce 12-month actionable window.
        const isWithin12Months = now.getTime() - thread.dateRange.last.getTime() <= TWELVE_MONTHS_MS;

        return {
          ...classification,
          threadId: thread.threadId,
          actionable: isWithin12Months ? classification.actionable : false,
          classifiedBy: "llm" as const,
        };
      } finally {
        semaphore.release();
      }
    })(),
  );

  return Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// proposeTaxonomy
// ---------------------------------------------------------------------------

/**
 * Sends up to 1000 thread content summaries to the provider and asks it to
 * suggest 5–15 category names based on the observed content patterns.
 *
 * @param threads   Array of ThreadSummary to sample from.
 * @param provider  ClassificationProvider to use.
 * @returns Array of suggested category name strings, or [] on failure.
 */
export async function proposeTaxonomy(threads: ThreadSummary[], provider: ClassificationProvider): Promise<string[]> {
  const sample = threads.slice(0, MAX_TAXONOMY_SAMPLE);

  const contentSummaries = sample.map(
    (t) => `Subject: ${t.subject}\nFrom: ${t.senderEmail}\n${t.content.slice(0, 500)}`,
  );

  const result = await provider.proposeTaxonomy(contentSummaries);
  if (!result.ok) {
    return [];
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fallback ThreadClassification for threads that failed to classify.
 */
function buildFallback(threadId: string): ThreadClassification {
  return {
    threadId,
    category: "uncategorized",
    confidence: 0,
    actionable: false,
    summary: "Classification failed.",
    classifiedBy: "llm",
  };
}

/**
 * Extracts a JSON string from raw LLM output.
 * Handles plain JSON, markdown code fences (```json ... ``` or ``` ... ```).
 * Returns null if no JSON-looking content is found.
 */
function extractJson(raw: string): string | null {
  const trimmed = raw.trim();

  // Strip markdown code fences: ```json\n...\n``` or ```\n...\n```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]{1,50000}?)\n?```\s*$/);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }

  // Accept if it starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  return null;
}
