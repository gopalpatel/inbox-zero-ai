/**
 * run-classification.ts
 *
 * Shared classification pipeline used by the main `classify` command.
 *
 * Design decisions:
 * - Deterministic rules run on metadata-only thread summaries first.
 * - Full body pulls are reserved for unmatched threads only.
 * - Thread/message mappings are built once and returned to the caller for
 *   downstream label application.
 * - All public exports return `Result<T>`; callers never receive raw throws.
 */

import type { GmailClient } from "../auth/gmail-client.js";
import type { ThreadClassification } from "../schemas/classification.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { pullBodies } from "./body-puller.js";
import type { ClassificationProvider } from "./llm-classifier.js";
import { classifyBatch } from "./llm-classifier.js";
import type { RulesConfig } from "./rule-engine.js";
import { classify } from "./rule-engine.js";
import type { ThreadSummary } from "./thread-collapser.js";
import { collapseThreads } from "./thread-collapser.js";

export interface RunClassificationOptions {
  client: GmailClient;
  emails: EmailMetadata[];
  dataDir: string;
  rulesConfig?: RulesConfig;
  provider?: ClassificationProvider;
}

export interface RunClassificationResult {
  allClassifications: ThreadClassification[];
  threadToMessageIds: Map<string, string[]>;
  threadCount: number;
  ruleClassifiedCount: number;
  llmClassifiedCount: number;
  unmatchedCount: number;
  pulledBodyCount: number;
}

export async function runClassification(options: RunClassificationOptions): Promise<Result<RunClassificationResult>> {
  const { client, emails, dataDir, rulesConfig, provider } = options;

  const threadToMessageIds = new Map<string, string[]>();
  for (const email of emails) {
    const existing = threadToMessageIds.get(email.threadId) ?? [];
    existing.push(email.messageId);
    threadToMessageIds.set(email.threadId, existing);
  }

  const metadataOnlyThreads = collapseThreads(emails, new Map());

  const ruleClassified: ThreadClassification[] = [];
  const unmatchedMetadataThreads: ThreadSummary[] = [];

  for (const thread of metadataOnlyThreads) {
    if (rulesConfig === undefined) {
      unmatchedMetadataThreads.push(thread);
      continue;
    }

    const result = classify(thread, rulesConfig);
    if (result === null) {
      unmatchedMetadataThreads.push(thread);
    } else {
      ruleClassified.push(result);
    }
  }

  let llmResults: ThreadClassification[] = [];
  let pulledBodyCount = 0;

  if (provider !== undefined && unmatchedMetadataThreads.length > 0) {
    const unmatchedThreadIds = new Set(unmatchedMetadataThreads.map((thread) => thread.threadId));
    const unmatchedMessageIds = unmatchedMetadataThreads.flatMap(
      (thread) => threadToMessageIds.get(thread.threadId) ?? [],
    );

    const bodyResult = await pullBodies({
      client,
      messageIds: unmatchedMessageIds,
      dataDir,
    });

    if (!bodyResult.ok) {
      return {
        ok: false,
        error: `Failed to pull bodies for unmatched threads: ${bodyResult.error}`,
      };
    }

    pulledBodyCount = unmatchedMessageIds.length;

    const unmatchedEmails = emails.filter((email) => unmatchedThreadIds.has(email.threadId));
    const unmatchedThreads = collapseThreads(unmatchedEmails, bodyResult.value);
    const existingCategories = [...new Set(ruleClassified.map((item) => item.category))];

    llmResults = await classifyBatch(unmatchedThreads, provider, existingCategories);
  }

  return {
    ok: true,
    value: {
      allClassifications: [...ruleClassified, ...llmResults],
      threadToMessageIds,
      threadCount: metadataOnlyThreads.length,
      ruleClassifiedCount: ruleClassified.length,
      llmClassifiedCount: llmResults.length,
      unmatchedCount: unmatchedMetadataThreads.length,
      pulledBodyCount,
    },
  };
}
