// src/enrichment/heuristic-classifier.ts
import type { SenderStats } from "../schemas/sender-stats.js";
import type { SenderType } from "../schemas/sender-type.js";
import { emailDomain } from "../utils.js";

export interface HeuristicResult {
  senderType: SenderType;
  confidence: number;
}

// --- Hard override local parts (always automated) ---
const AUTOMATED_LOCAL_PARTS = new Set(["noreply", "no-reply", "notifications", "mailer", "digest"]);

// --- Freemail domains (strong human signal) ---
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "gmx.com",
  "fastmail.com",
  "tutanota.com",
  "hey.com",
  "live.com",
  "msn.com",
  "me.com",
  "mac.com",
  "yahoo.co.uk",
]);

// --- Automated local parts (soft — not hard overrides) ---
const SOFT_AUTOMATED_LOCAL_PARTS = new Set([
  "support",
  "billing",
  "info",
  "team",
  "hello",
  "updates",
  "news",
  "marketing",
  "contact",
  "admin",
  "sales",
]);

// --- Display name corporate keywords ---
const CORPORATE_KEYWORDS = /\b(team|inc|llc|corp)\b/iu;
const NEWSLETTER_KEYWORDS = /\b(newsletter|updates|digest|news|weekly|daily|monthly)\b/iu;

// --- Subject template patterns ---
const TEMPLATE_SUBJECT_PATTERNS = [
  /your\s+(order|receipt|invoice|statement|subscription|account)/iu,
  /order\s*#/iu,
  /shipping\s+(update|confirmation|notification)/iu,
  /(weekly|daily|monthly)\s+(digest|report|summary|update|roundup)/iu,
];

// --- Conversational subject patterns ---
const CONVERSATIONAL_PATTERNS = [/^Re:\s/u, /^Fwd:\s/u];

// --- Human name pattern: 2-3 capitalized words, no special chars ---
const HUMAN_NAME_PATTERN = /^[A-Z][a-z]{1,20}(\s[A-Z][a-z]{1,20}){1,2}$/u;

export function classifyHeuristic(sender: SenderStats): HeuristicResult {
  const localPart = sender.senderEmail.split("@")[0]?.toLowerCase() ?? "";
  const domain = emailDomain(sender.senderEmail).toLowerCase();

  // --- Hard override: automated local parts ---
  if (AUTOMATED_LOCAL_PARTS.has(localPart)) {
    return { senderType: "automated", confidence: 0.95 };
  }

  // --- Weighted voting ---
  const scores: Record<Exclude<SenderType, "unknown">, number> = {
    human: 0,
    company: 0,
    newsletter: 0,
    automated: 0,
  };

  // Signal 1: Freemail domain
  if (FREEMAIL_DOMAINS.has(domain)) {
    scores.human += 0.7;
  }

  // Signal 2: Soft automated local parts (weak signal — can be overridden by name/domain)
  if (SOFT_AUTOMATED_LOCAL_PARTS.has(localPart)) {
    scores.automated += 0.3;
  }

  // Signal 3: Display name analysis
  const name = sender.senderName.trim();
  if (name.length > 0) {
    if (HUMAN_NAME_PATTERN.test(name)) {
      scores.human += 0.4;
    }
    if (NEWSLETTER_KEYWORDS.test(name)) {
      scores.newsletter += 0.5;
    } else if (CORPORATE_KEYWORDS.test(name)) {
      scores.company += 0.5;
    }
    if (name === "" || name.toLowerCase() === localPart) {
      scores.automated += 0.3;
    }
  } else {
    scores.automated += 0.3;
  }

  // Signal 4: Thread ratio
  if (sender.emailCount > 0) {
    const threadRatio = sender.threadCount / sender.emailCount;
    if (threadRatio >= 0.7) {
      scores.human += 0.3;
    } else if (threadRatio <= 0.1) {
      scores.newsletter += 0.2;
      scores.automated += 0.2;
    }
  }

  // Signal 5: Subject pattern detection
  const subjects = sender.sampleSubjects;
  const templateMatches = subjects.filter((s) => TEMPLATE_SUBJECT_PATTERNS.some((p) => p.test(s))).length;
  const conversationalMatches = subjects.filter((s) => CONVERSATIONAL_PATTERNS.some((p) => p.test(s))).length;

  if (templateMatches > 0 && subjects.length > 0) {
    const ratio = templateMatches / subjects.length;
    scores.newsletter += 0.5 * ratio;
    scores.automated += 0.2 * ratio;
  }
  if (conversationalMatches > 0 && subjects.length > 0) {
    scores.human += 0.3 * (conversationalMatches / subjects.length);
  }

  // --- Find winner ---
  let bestType: SenderType = "unknown";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type as SenderType;
    } else if (score === bestScore && score > 0 && type !== "human") {
      // Tie-break: prefer non-human (cautious approach)
      bestType = type as SenderType;
    }
  }

  if (bestScore < 0.6) {
    return { senderType: "unknown", confidence: bestScore };
  }

  // Normalize confidence to 0-1 range (cap at 1.0)
  const confidence = Math.min(bestScore, 1.0);
  return { senderType: bestType, confidence };
}
