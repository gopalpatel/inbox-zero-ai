// src/enrichment/extraction-scorer.ts
import type { SenderStats } from "../schemas/sender-stats.js";

/** Weight for reply/conversation proxy signal */
const REPLY_WEIGHT = 0.4;

/** Weight for read behavior signal */
const READ_WEIGHT = 0.3;

/** Weight for explicit signals (starred + important) */
const EXPLICIT_WEIGHT = 0.2;

/** Weight for content feature signals */
const CONTENT_WEIGHT = 0.1;

/**
 * Minimum composite score required to flag a sender as an extraction candidate.
 * Composite is a weighted sum of four signals, each normalized to [0, 1].
 */
const THRESHOLD = 0.5;

/**
 * Thread ratio at which the reply signal saturates to a score of 1.0.
 * A threadCount/emailCount ratio of 0.5 or higher means the sender frequently
 * appears in back-and-forth conversations.
 */
const REPLY_SATURATION_RATIO = 0.5;

/**
 * Explicit signal ratio at which the starred/important signal saturates to 1.0.
 * 10% of emails from this sender being starred or marked important = max score.
 */
const EXPLICIT_SATURATION_RATIO = 0.1;

/**
 * Minimum email count before a sender is eligible for extraction scoring.
 * Senders with fewer than 3 emails have insufficient signal.
 */
const MIN_EMAIL_COUNT = 3;

/**
 * Scores a sender for potential extraction to Obsidian in Phase 2.
 *
 * Computes a composite score from four weighted signals:
 *   - Reply/conversation proxy (0.40): threadCount/emailCount ratio
 *   - Read behavior (0.30): 1 - unreadRatio
 *   - Explicit signals (0.20): (starredCount + importantCount) / emailCount
 *   - Content features (0.10): human type, primary category, sufficient volume
 *
 * @returns true if the composite score meets the extraction threshold and
 *          the sender has at least MIN_EMAIL_COUNT emails; false otherwise.
 */
export function scoreExtraction(sender: SenderStats): boolean {
  if (sender.emailCount < MIN_EMAIL_COUNT) return false;

  // Reply/conversation proxy: threadCount / emailCount, normalized so 0.5+ = max
  const threadRatio = sender.emailCount > 0 ? sender.threadCount / sender.emailCount : 0;
  const replyScore = Math.min(threadRatio / REPLY_SATURATION_RATIO, 1.0);

  // Read behavior: fully read = 1.0, fully unread = 0.0
  const readScore = 1 - sender.unreadRatio;

  // Explicit signals: (starredCount + importantCount) / emailCount, normalized so 10%+ = max
  const explicitRatio = (sender.starredCount + sender.importantCount) / sender.emailCount;
  const explicitScore = Math.min(explicitRatio / EXPLICIT_SATURATION_RATIO, 1.0);

  // Content features: additive sub-scores summing to at most 1.0
  let contentScore = 0;
  if (sender.senderType === "human") contentScore += 0.5;
  if (sender.gmailCategory === "primary") contentScore += 0.3;
  if (sender.emailCount >= MIN_EMAIL_COUNT) contentScore += 0.2;

  const composite =
    REPLY_WEIGHT * replyScore +
    READ_WEIGHT * readScore +
    EXPLICIT_WEIGHT * explicitScore +
    CONTENT_WEIGHT * contentScore;

  return composite >= THRESHOLD;
}
