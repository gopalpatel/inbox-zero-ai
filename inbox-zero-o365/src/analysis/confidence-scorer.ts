import type { ConfidenceTier, RecommendedAction, SenderStats } from "../schemas/sender-stats.js";
import { emailDomain } from "../utils.js";

// ---------------------------------------------------------------------------
// Threshold constants — named with JSDoc for traceability
// ---------------------------------------------------------------------------

/**
 * Noise score at or above this threshold → `definitely_noise` + `unsubscribe`.
 * Represents very strong evidence the sender is automated junk.
 */
const NOISE_THRESHOLD_DEFINITELY = 0.7;

/**
 * Noise score at or above this threshold (but below DEFINITELY) →
 * `probably_noise` + `filter`.
 */
const NOISE_THRESHOLD_PROBABLY = 0.5;

/**
 * Noise score at or above this threshold (but below PROBABLY_NOISE) →
 * `probably_keep` + `keep`.
 */
const NOISE_THRESHOLD_PROBABLY_KEEP = 0.3;

// Below NOISE_THRESHOLD_PROBABLY_KEEP → `definitely_keep` + `keep`.

// ---------------------------------------------------------------------------
// Weight constants — must sum to 1.0
// ---------------------------------------------------------------------------

/** Weight for unread ratio signal: higher unread = more likely noise. */
const WEIGHT_UNREAD_RATIO = 0.3;

/** Weight for Gmail category signal: Promotions/Social = noise, Primary = keep. */
const WEIGHT_GMAIL_CATEGORY = 0.2;

/** Weight for recency signal: older = less important / more likely dormant noise. */
const WEIGHT_RECENCY = 0.15;

/** Weight for thread count signal: more threads = more likely real relationship. */
const WEIGHT_THREAD_COUNT = 0.1;

/** Weight for sender type signal: automated/newsletter = noise, human = keep. */
const WEIGHT_SENDER_TYPE = 0.25;

// ---------------------------------------------------------------------------
// Surprise-detection thresholds
// ---------------------------------------------------------------------------

/**
 * Unread ratio must be strictly above this threshold to trigger the surprise flag
 * for a Primary-category sender.
 */
const SURPRISE_UNREAD_RATIO_THRESHOLD = 0.8;

/**
 * Email count must be strictly above this threshold (i.e. > 20) to trigger the
 * surprise flag for a Primary-category sender.
 */
const SURPRISE_EMAIL_COUNT_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Conservative default threshold
// ---------------------------------------------------------------------------

/**
 * Senders with this email count or fewer are given the conservative default
 * of `probably_keep` — there is not enough signal to classify them as noise.
 */
const MIN_EMAIL_COUNT_FOR_SCORING = 1;

// ---------------------------------------------------------------------------
// Recency thresholds (in days)
// ---------------------------------------------------------------------------

/**
 * Emails received within this many days are considered very recent (low noise score).
 */
const RECENCY_RECENT_DAYS = 90;

/**
 * Emails received within this many days (but older than RECENT) are considered
 * moderately old — mid noise score.
 */
const RECENCY_MODERATE_DAYS = 365;

// Emails older than RECENCY_MODERATE_DAYS score as very old noise signal.

// ---------------------------------------------------------------------------
// Thread-count thresholds
// ---------------------------------------------------------------------------

/**
 * Senders with thread count above this value score as a strong "keep" signal.
 * Many threads usually mean real back-and-forth conversations.
 */
const THREAD_COUNT_HIGH = 10;

/**
 * Senders with thread count above this value (but ≤ HIGH) score as a moderate
 * "keep" signal.
 */
const THREAD_COUNT_MEDIUM = 3;

// Thread count ≤ MEDIUM scores as a noise signal (very few threads).

// ---------------------------------------------------------------------------
// Sender type noise mapping — maps senderType to a noise contribution (0–1).
// human (0.0) = strong keep, automated (0.9) = strong noise.
// ---------------------------------------------------------------------------

const SENDER_TYPE_NOISE: Record<string, number> = {
  human: 0.0,
  company: 0.5,
  newsletter: 0.8,
  automated: 0.9,
  unknown: 0.5,
};

// ---------------------------------------------------------------------------
// Known automated / marketing sender localparts (matched against the local
// part of the email, before the @, case-insensitively)
// ---------------------------------------------------------------------------

/** Local-part prefixes that indicate automated / no-reply senders. */
const NOREPLY_LOCALPARTS: ReadonlyArray<string> = ["noreply", "no-reply", "notifications"];

// ---------------------------------------------------------------------------
// Known marketing / transactional email infrastructure domains
// ---------------------------------------------------------------------------

/**
 * Domains (and their subdomains) whose email is almost certainly automated
 * marketing infrastructure — not real people.
 */
const MARKETING_DOMAINS: ReadonlyArray<string> = [
  "mailchimp.com",
  "sendgrid.net",
  "constantcontact.com",
  "klaviyo.com",
  "campaignmonitor.com",
  "marketo.net",
  "mailgun.org",
  "amazonses.com",
  "postmarkapp.com",
  "sparkpostmail.com",
];

/**
 * Apex vendor domains that are often automated but can also represent real
 * human correspondence. Treat these as a soft signal, not a hard override.
 */
const SOFT_MARKETING_DOMAINS: ReadonlyArray<string> = ["salesforce.com", "hubspot.com"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase version of the sender email's local part (before `@`).
 */
function localPart(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email.toLowerCase();
  return email.slice(0, atIndex).toLowerCase();
}

/**
 * Returns the lowercase domain of a sender email (after `@`).
 * Delegates to the shared `emailDomain` utility.
 */
function domain(email: string): string {
  return emailDomain(email);
}

/**
 * Returns true if the email is from a known no-reply / notifications address.
 * Matched case-insensitively against the local part.
 */
function isNoreplyAddress(email: string): boolean {
  const local = localPart(email);
  for (const prefix of NOREPLY_LOCALPARTS) {
    if (local === prefix) return true;
  }
  return false;
}

/**
 * Returns true if the email's domain is a known marketing infrastructure domain
 * or a subdomain of one (e.g. `r.mailchimp.com` matches `mailchimp.com`).
 */
function isMarketingDomain(email: string): boolean {
  const senderDomain = domain(email);
  if (senderDomain === "") return false;

  for (const marketingDomain of MARKETING_DOMAINS) {
    if (senderDomain === marketingDomain) return true;
    if (senderDomain.endsWith(`.${marketingDomain}`)) return true;
  }
  return false;
}

function isSoftMarketingDomain(email: string): boolean {
  const senderDomain = domain(email);
  if (senderDomain === "") return false;

  for (const marketingDomain of SOFT_MARKETING_DOMAINS) {
    if (senderDomain === marketingDomain) return true;
    if (senderDomain.endsWith(`.${marketingDomain}`)) return true;
  }
  return false;
}

/**
 * Returns the noise contribution for the unread ratio signal (0–1).
 * Higher unread ratio = higher noise score.
 */
function unreadRatioSignal(unreadRatio: number): number {
  // Linear: 0 unread → 0 noise, 1.0 unread → 1.0 noise
  return unreadRatio;
}

/**
 * Returns the noise contribution for the Gmail category signal (0–1).
 * Promotions/Social = strong noise signal; Primary = strong keep signal.
 */
function gmailCategorySignal(category: string): number {
  const cat = category.toLowerCase();
  if (cat === "promotions") return 1.0;
  if (cat === "social") return 0.8;
  if (cat === "updates") return 0.6;
  if (cat === "forums") return 0.5;
  if (cat === "primary") return 0.0;
  // unknown or anything else — neutral
  return 0.5;
}

/**
 * Returns the noise contribution for the recency signal (0–1).
 * Very recent emails → low noise; very old emails → high noise.
 *
 * @param lastEmailDate ISO date string of the last email.
 * @param now           Current timestamp in ms (passed in to avoid repeated Date.now() calls).
 */
function recencySignal(lastEmailDate: string, now: number): number {
  const last = new Date(lastEmailDate).getTime();
  if (Number.isNaN(last)) {
    throw new Error(`Invalid lastEmailDate in sender stats: ${lastEmailDate}`);
  }
  const ageMs = now - last;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays <= RECENCY_RECENT_DAYS) return 0.0; // very recent — keep signal
  if (ageDays <= RECENCY_MODERATE_DAYS) return 0.4; // moderate age
  return 0.9; // very old — dormant / noise signal
}

/**
 * Returns the noise contribution for the thread count signal (0–1).
 * Many threads = strong keep signal; few threads = noise signal.
 */
function threadCountSignal(threadCount: number): number {
  if (threadCount > THREAD_COUNT_HIGH) return 0.0; // many threads → keep
  if (threadCount > THREAD_COUNT_MEDIUM) return 0.3; // some threads → lean keep
  return 0.8; // very few threads → noise signal
}

/**
 * Derives `confidenceTier` and `recommendedAction` from a weighted noise score.
 */
function tierFromScore(noiseScore: number): {
  confidenceTier: ConfidenceTier;
  recommendedAction: RecommendedAction;
} {
  if (noiseScore >= NOISE_THRESHOLD_DEFINITELY) {
    return { confidenceTier: "definitely_noise", recommendedAction: "unsubscribe" };
  }
  if (noiseScore >= NOISE_THRESHOLD_PROBABLY) {
    return { confidenceTier: "probably_noise", recommendedAction: "filter" };
  }
  if (noiseScore >= NOISE_THRESHOLD_PROBABLY_KEEP) {
    return { confidenceTier: "probably_keep", recommendedAction: "keep" };
  }
  return { confidenceTier: "definitely_keep", recommendedAction: "keep" };
}

/**
 * Computes the `surprisesFlag` value.
 * Returns true when a Primary-category sender has an unexpectedly high unread
 * ratio and high email count — this doesn't match the typical Primary pattern.
 */
function computeSurprisesFlag(stats: SenderStats): boolean {
  return (
    stats.gmailCategory.toLowerCase() === "primary" &&
    stats.unreadRatio > SURPRISE_UNREAD_RATIO_THRESHOLD &&
    stats.emailCount > SURPRISE_EMAIL_COUNT_THRESHOLD
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scores a single `SenderStats` object and returns a new object with
 * `confidenceTier`, `recommendedAction`, and `surprisesFlag` populated.
 *
 * The input object is never mutated.
 *
 * Scoring strategy:
 * 1. **Hard overrides** short-circuit for known no-reply addresses and known
 *    marketing domains → always `definitely_noise` + `unsubscribe`.
 * 2. **Conservative default** for senders with only 1 email → `probably_keep`
 *    (not enough signal).
 * 3. **Weighted scoring** for all other senders using five signals:
 *    unread ratio (0.30), Gmail category (0.20), recency (0.15),
 *    thread count (0.10), sender type (0.25).
 */
export function scoreConfidence(stats: SenderStats, now?: number): SenderStats {
  const nowMs = now ?? Date.now();
  // ------------------------------------------------------------------
  // Hard override 1: known no-reply / notifications local parts
  // ------------------------------------------------------------------
  if (isNoreplyAddress(stats.senderEmail)) {
    return {
      ...stats,
      confidenceTier: "definitely_noise",
      recommendedAction: "unsubscribe",
      surprisesFlag: false,
    };
  }

  // ------------------------------------------------------------------
  // Hard override 2: known marketing infrastructure domains
  // ------------------------------------------------------------------
  if (isMarketingDomain(stats.senderEmail)) {
    return {
      ...stats,
      confidenceTier: "definitely_noise",
      recommendedAction: "unsubscribe",
      surprisesFlag: false,
    };
  }

  // ------------------------------------------------------------------
  // Conservative default: only 1 email — not enough signal
  // ------------------------------------------------------------------
  if (stats.emailCount <= MIN_EMAIL_COUNT_FOR_SCORING) {
    return {
      ...stats,
      confidenceTier: "probably_keep",
      recommendedAction: "keep",
      surprisesFlag: false,
    };
  }

  // ------------------------------------------------------------------
  // Weighted noise score (5 signals)
  // ------------------------------------------------------------------
  const senderTypeNoise = SENDER_TYPE_NOISE[stats.senderType ?? "unknown"] ?? 0.5;
  const weightedSenderTypeNoise = isSoftMarketingDomain(stats.senderEmail)
    ? Math.max(senderTypeNoise, 0.6)
    : senderTypeNoise;
  const noiseScore =
    WEIGHT_UNREAD_RATIO * unreadRatioSignal(stats.unreadRatio) +
    WEIGHT_GMAIL_CATEGORY * gmailCategorySignal(stats.gmailCategory) +
    WEIGHT_RECENCY * recencySignal(stats.lastEmailDate, nowMs) +
    WEIGHT_THREAD_COUNT * threadCountSignal(stats.threadCount) +
    WEIGHT_SENDER_TYPE * weightedSenderTypeNoise;

  const { confidenceTier, recommendedAction } = tierFromScore(noiseScore);
  const surprisesFlag = computeSurprisesFlag(stats);

  return { ...stats, confidenceTier, recommendedAction, surprisesFlag };
}

/**
 * Convenience wrapper that scores an array of `SenderStats` objects.
 * Returns a new array — the input array and its objects are never mutated.
 */
export function scoreAll(stats: SenderStats[]): SenderStats[] {
  const now = Date.now();
  return stats.map((s) => scoreConfidence(s, now));
}
