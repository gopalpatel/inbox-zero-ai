import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SenderStats } from "../schemas/sender-stats.js";
import type { SenderType } from "../schemas/sender-type.js";
import { SenderTypeEnum } from "../schemas/sender-type.js";
import { chunkArray, emailDomain } from "../utils.js";

/** Maximum senders per LLM API call. */
const BATCH_SIZE = 50;

/** Claude Haiku model identifier for cost-efficient batch classification. */
const MODEL = "claude-haiku-4-5-20251001";

export interface FewShotExample {
  email: string;
  senderType: SenderType;
  context: string;
}

export interface ClassificationResult {
  senderType: SenderType;
  confidence: number;
}

/**
 * Interface for LLM-based sender classification.
 * Defined here to avoid circular imports with the enrichment orchestrator (Task 7).
 */
export interface LlmSenderProvider {
  classifySenders(
    senders: SenderStats[],
    fewShotExamples: FewShotExample[],
  ): Promise<Map<string, ClassificationResult>>;
}

// --- Zod schema for parsing individual LLM response entries ---

const LlmEntrySchema = z.object({
  email: z.string(),
  senderType: SenderTypeEnum,
  confidence: z.number().min(0).max(1),
});

// --- Prompt construction ---

/**
 * Builds the system and user messages for a batch classification request.
 * Includes few-shot examples in the system message when provided.
 */
export function buildClassificationPrompt(
  senders: SenderStats[],
  fewShotExamples: FewShotExample[],
): { systemMessage: string; userMessage: string } {
  let systemMessage = `You classify email senders into exactly one of: human, company, newsletter, automated, unknown.
Return a JSON array. Each element: {"email": "...", "senderType": "...", "confidence": 0.0-1.0}.
Only output the JSON array, no other text.`;

  if (fewShotExamples.length > 0) {
    systemMessage += "\n\nExamples of previously classified senders:\n";
    for (const ex of fewShotExamples) {
      systemMessage += `- ${ex.email} → ${ex.senderType} (${ex.context})\n`;
    }
  }

  const senderData = senders.map((s) => ({
    email: s.senderEmail,
    name: s.senderName,
    domain: emailDomain(s.senderEmail),
    subjects: s.sampleSubjects.slice(0, 5),
    emailCount: s.emailCount,
    gmailCategory: s.gmailCategory,
    unreadRatio: Math.round(s.unreadRatio * 100) / 100,
    threadCount: s.threadCount,
  }));

  const userMessage = `Classify these senders:\n${JSON.stringify(senderData, null, 2)}`;

  return { systemMessage, userMessage };
}

// --- Response parsing ---

/**
 * Extracts and validates a JSON array of classification entries from LLM response text.
 * Skips malformed or invalid entries without failing the entire batch.
 * Returns an empty array when the response cannot be parsed at all.
 */
export function parseClassificationResponse(text: string): Array<{ email: string } & ClassificationResult> {
  // Extract JSON array from response (may have surrounding text)
  // Use non-greedy match to avoid over-capture when response has multiple bracketed sections
  const jsonMatches = text.matchAll(/\[[\s\S]*?\]/gu);
  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) continue;

      const results: Array<{ email: string } & ClassificationResult> = [];
      for (const item of parsed) {
        const validated = LlmEntrySchema.safeParse(item);
        if (validated.success) {
          results.push({
            email: validated.data.email,
            senderType: validated.data.senderType,
            confidence: validated.data.confidence,
          });
        }
      }

      if (results.length > 0) {
        return results;
      }
    } catch {}
  }
  return [];
}

// --- Orchestrator ---

/**
 * Classifies senders in batches using the Claude Haiku LLM.
 * Retries once on parse failure; marks remaining senders as `unknown` after exhausting retries.
 *
 * @param senders - Full list of senders to classify.
 * @param client - Anthropic API client.
 * @param fewShotExamples - Examples to inject into the system prompt.
 * @param onProgress - Optional callback invoked after each batch completes.
 */
export async function classifySendersWithLlm(
  senders: SenderStats[],
  client: Anthropic,
  fewShotExamples: FewShotExample[],
  onProgress?: (info: { batch: number; total: number }) => void,
): Promise<Map<string, ClassificationResult>> {
  const results = new Map<string, ClassificationResult>();
  const batches = chunkArray(senders, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const { systemMessage, userMessage } = buildClassificationPrompt(batch, fewShotExamples);
    const batchEmails = new Set(batch.map((sender) => sender.senderEmail.toLowerCase()));

    let retries = 0;

    while (retries < 2) {
      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: systemMessage,
          messages: [{ role: "user", content: userMessage }],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        const responseText = textBlock?.text ?? "";

        const parsed = parseClassificationResponse(responseText);
        if (parsed.length > 0) {
          const parsedByEmail = new Map<string, ClassificationResult>();

          for (const entry of parsed) {
            const email = entry.email.toLowerCase();
            if (!batchEmails.has(email) || parsedByEmail.has(email)) {
              continue;
            }
            parsedByEmail.set(email, { senderType: entry.senderType, confidence: entry.confidence });
          }

          for (const [email, classification] of parsedByEmail) {
            results.set(email, classification);
          }

          const complete = batch.every((sender) => parsedByEmail.has(sender.senderEmail.toLowerCase()));
          if (complete) {
            break;
          }
        }
        retries++;
      } catch {
        retries++;
      }
    }

    // Mark any senders not classified as unknown after exhausting retries
    for (const sender of batch) {
      if (!results.has(sender.senderEmail.toLowerCase())) {
        results.set(sender.senderEmail.toLowerCase(), { senderType: "unknown", confidence: 0 });
      }
    }

    try {
      onProgress?.({ batch: i + 1, total: batches.length });
    } catch {
      // Non-fatal: caller-provided callback failure must not abort batch processing
    }
  }

  return results;
}

// --- Factory ---

/**
 * Creates an LlmSenderProvider backed by the Anthropic API.
 * The returned provider wraps `classifySendersWithLlm` with a managed client instance.
 */
export function createLlmSenderProvider(apiKey: string): LlmSenderProvider {
  const client = new Anthropic({ apiKey });

  return {
    async classifySenders(
      senders: SenderStats[],
      fewShotExamples: FewShotExample[],
    ): Promise<Map<string, ClassificationResult>> {
      return classifySendersWithLlm(senders, client, fewShotExamples);
    },
  };
}
