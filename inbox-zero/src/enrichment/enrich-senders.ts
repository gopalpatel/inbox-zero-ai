// src/enrichment/enrich-senders.ts
import type { SenderStats } from "../schemas/sender-stats.js";
import type { SenderType, SenderTypeSource } from "../schemas/sender-type.js";
import { scoreExtraction } from "./extraction-scorer.js";
import { classifyHeuristic } from "./heuristic-classifier.js";
import type { FewShotExample, LlmSenderProvider } from "./llm-sender-classifier.js";

export type { FewShotExample, LlmSenderProvider };

/**
 * Extended sender type that may carry user-review fields from SenderStateEntry.
 * The orchestrator accepts plain SenderStats too — these fields are optional.
 */
export type EnrichableSender = SenderStats & {
  senderTypeSource?: SenderTypeSource;
  reviewedSenderType?: SenderType;
  reviewedAt?: string;
};

export interface EnrichOptions {
  /** Optional LLM provider for Phase 2 classification of ambiguous senders. */
  llmProvider: LlmSenderProvider | undefined;
  /** Few-shot examples forwarded to the LLM provider. */
  fewShotExamples: FewShotExample[];
  /** Optional progress callback invoked after each phase. */
  onProgress?: (info: { phase: string; processed: number; total: number }) => void;
}

/**
 * Enriches a list of senders through a three-phase pipeline:
 *
 * Phase 0: Preserve user-reviewed types verbatim (skip reclassification).
 * Phase 1: Run heuristic classifier on remaining senders.
 * Phase 2: Send still-ambiguous senders to LLM (if provider given).
 * Phase 3: Score extraction candidates on all senders.
 *
 * The input array and its objects are never mutated.
 */
export async function enrichSenders(senders: EnrichableSender[], options: EnrichOptions): Promise<EnrichableSender[]> {
  const total = senders.length;
  const orderedResults = new Array<EnrichableSender | undefined>(senders.length);
  const ambiguous: Array<{ index: number; sender: EnrichableSender }> = [];
  let heuristicResolved = 0;

  // --- Phase 0 + Phase 1: Preserve user-reviewed OR classify via heuristics ---
  for (const [index, sender] of senders.entries()) {
    const isUserReviewed = sender.senderTypeSource === "user" || sender.reviewedSenderType !== undefined;

    if (isUserReviewed) {
      // Phase 0: carry forward user-reviewed classification as-is
      orderedResults[index] = {
        ...sender,
        senderType: sender.reviewedSenderType ?? sender.senderType ?? "unknown",
        senderTypeSource: "user" as SenderTypeSource,
      };
      heuristicResolved++;
      continue;
    }

    // Phase 1: heuristic classification
    const result = classifyHeuristic(sender);
    if (result.senderType !== "unknown") {
      orderedResults[index] = {
        ...sender,
        senderType: result.senderType,
        senderTypeConfidence: result.confidence,
        senderTypeSource: "heuristic" as SenderTypeSource,
      };
      heuristicResolved++;
    } else {
      ambiguous.push({ index, sender });
    }
  }

  options.onProgress?.({
    phase: "heuristic",
    processed: heuristicResolved,
    total,
  });

  // --- Phase 2: LLM classification for ambiguous senders ---
  const llmResults =
    options.llmProvider !== undefined && ambiguous.length > 0
      ? await options.llmProvider.classifySenders(
          ambiguous.map(({ sender }) => sender),
          options.fewShotExamples,
        )
      : new Map<string, { senderType: SenderType; confidence: number }>();

  for (const { index, sender } of ambiguous) {
    const llmResult = llmResults.get(sender.senderEmail.toLowerCase());
    if (llmResult !== undefined) {
      orderedResults[index] = {
        ...sender,
        senderType: llmResult.senderType,
        senderTypeConfidence: llmResult.confidence,
        senderTypeSource: "llm" as SenderTypeSource,
      };
    } else {
      orderedResults[index] = {
        ...sender,
        senderType: "unknown",
        senderTypeConfidence: 0,
      };
    }
  }

  options.onProgress?.({
    phase: "llm",
    processed: total,
    total,
  });

  // --- Phase 3: Extraction candidate scoring ---
  const result = orderedResults.map((sender) => {
    if (sender === undefined) {
      throw new Error("enrichSenders produced an incomplete result set");
    }

    return {
      ...sender,
      extractionCandidate: scoreExtraction(sender),
    };
  });

  options.onProgress?.({
    phase: "extraction",
    processed: result.length,
    total,
  });

  return result;
}
