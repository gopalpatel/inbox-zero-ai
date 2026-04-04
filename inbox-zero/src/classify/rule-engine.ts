/**
 * rule-engine.ts
 *
 * Deterministic, config-driven classifier that runs before the LLM.
 *
 * Design decisions:
 * - Rules are loaded from a JSON file at a caller-supplied path (not hardcoded).
 * - Sender rules take priority over domain rules.
 * - Null category values mean "I know this sender but haven't decided — skip to LLM".
 * - Matching is case-insensitive to avoid missed matches due to email casing.
 * - All public functions return Result<T> so callers never receive raw exceptions.
 */

import * as fs from "node:fs";
import { z } from "zod";
import type { ThreadClassification } from "../schemas/classification.js";
import type { SenderStats } from "../schemas/sender-stats.js";
import type { Result } from "../types.js";
import { emailDomain, TWELVE_MONTHS_MS, toErrorMessage } from "../utils.js";
import type { ThreadSummary } from "./thread-collapser.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// TWELVE_MONTHS_MS imported from ../utils.js

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

/**
 * Schema for the JSON rules configuration file.
 *
 * - `domainRules`: maps domain (e.g. "chase.com") to category string or null.
 * - `senderRules`: maps exact sender email to category string or null.
 *
 * Null values indicate the sender/domain is a known candidate that hasn't been
 * assigned a category yet; the rule engine will treat them as unmatched and
 * pass control to the LLM classifier.
 */
export const RulesConfigSchema = z.object({
  domainRules: z.record(z.string(), z.string().nullable()),
  senderRules: z.record(z.string(), z.string().nullable()),
});

export type RulesConfig = z.infer<typeof RulesConfigSchema>;

// ---------------------------------------------------------------------------
// loadRules
// ---------------------------------------------------------------------------

/**
 * Reads a JSON rules config file from `configPath`, validates it against
 * `RulesConfigSchema`, and returns the parsed config.
 *
 * @param configPath  Absolute or relative path to the JSON config file.
 * @returns `{ ok: true, value: RulesConfig }` or `{ ok: false, error: string }`.
 */
export function loadRules(configPath: string): Result<RulesConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    const message = toErrorMessage(err);
    const isNotFound =
      message.includes("ENOENT") ||
      message.includes("no such file") ||
      (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT");
    return {
      ok: false,
      error: isNotFound ? `Config file not found: ${configPath}` : `Failed to read config file: ${message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return { ok: false, error: `Failed to parse JSON: ${toErrorMessage(err)}` };
  }

  const result = RulesConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid rules config schema: ${result.error.message}`,
    };
  }

  // Pre-normalize all keys to lowercase so findRuleMatch can do direct lookups.
  const normalized: RulesConfig = {
    domainRules: Object.fromEntries(Object.entries(result.data.domainRules).map(([k, v]) => [k.toLowerCase(), v])),
    senderRules: Object.fromEntries(Object.entries(result.data.senderRules).map(([k, v]) => [k.toLowerCase(), v])),
  };

  return { ok: true, value: normalized };
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * Classifies a single thread using the loaded rules config.
 *
 * Lookup priority:
 * 1. Check `senderRules[senderEmail]` (exact match, case-insensitive).
 * 2. Check `domainRules[domain]` (domain extracted from sender email).
 *
 * If the matched rule's category is `null`, the thread is treated as unmatched
 * and `null` is returned so the LLM classifier can handle it.
 *
 * @param threadSummary  Collapsed thread to classify.
 * @param rules          Parsed rules config from `loadRules`.
 * @returns `ThreadClassification` with `classifiedBy: "rule"`, or `null` if
 *          no rule matched (or matched rule has a null category).
 */
export function classify(threadSummary: ThreadSummary, rules: RulesConfig): ThreadClassification | null {
  const senderLower = threadSummary.senderEmail.toLowerCase().trim();

  // --- Build lowercase lookup maps once per call ---
  // (Rules configs are small so this is acceptable; avoids O(n) scan.)

  // Check exact sender rule first (higher priority).
  const senderMatch = findRuleMatch(rules.senderRules, senderLower);
  if (senderMatch !== undefined) {
    // Found a sender rule — null category means pass to LLM.
    if (senderMatch.category === null) return null;
    return buildClassification(threadSummary, senderMatch.category, `sender:${senderMatch.key}`);
  }

  // Extract domain from sender email.
  const domain = emailDomain(senderLower);
  if (domain === "") return null; // malformed email — cannot extract domain

  // Check domain rule.
  const domainMatch = findRuleMatch(rules.domainRules, domain);
  if (domainMatch !== undefined) {
    if (domainMatch.category === null) return null;
    return buildClassification(threadSummary, domainMatch.category, `domain:${domainMatch.key}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// buildRulesTemplateFromAudit
// ---------------------------------------------------------------------------

/**
 * Generates a starter `RulesConfig` template from a list of sender stats.
 *
 * All categories are set to `null` so the human can fill them in before the
 * rule engine runs. Domains are deduplicated; both domains and sender emails
 * are included as candidates.
 *
 * Blank or whitespace-only sender emails are filtered out.
 *
 * @param stats  Array of SenderStats from the audit sheet.
 * @returns A `RulesConfig` with all keys present and all values `null`.
 */
export function buildRulesTemplateFromAudit(stats: SenderStats[]): RulesConfig {
  const domainRules: Record<string, null> = {};
  const senderRules: Record<string, null> = {};

  for (const stat of stats) {
    const email = stat.senderEmail.trim();
    if (email.length === 0) continue;

    // Add sender as a candidate.
    senderRules[email] = null;

    // Extract and deduplicate domain.
    const atIndex = email.indexOf("@");
    if (atIndex !== -1) {
      const domain = email.slice(atIndex + 1).toLowerCase();
      if (domain.length > 0) {
        domainRules[domain] = null;
      }
    }
  }

  return { domainRules, senderRules };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RuleMatch {
  /** Original key from the rules map (preserves casing for ruleName). */
  key: string;
  category: string | null;
}

/**
 * Looks up a rule by key from a pre-normalized (lowercase keys) rules record.
 *
 * Returns the matched key and category, or `undefined` if no match is found.
 */
function findRuleMatch(rulesMap: Record<string, string | null>, lookupKey: string): RuleMatch | undefined {
  if (!Object.hasOwn(rulesMap, lookupKey)) return undefined;
  const category = rulesMap[lookupKey];
  if (category === undefined) return undefined;
  return { key: lookupKey, category };
}

/**
 * Constructs a `ThreadClassification` for a rule engine match.
 *
 * - `confidence` is always `1.0` — deterministic rules are fully confident.
 * - `actionable` is `true` when the thread's last message is within 12 months.
 * - `summary` is an empty string — rule matches don't generate summaries.
 */
function buildClassification(thread: ThreadSummary, category: string, ruleName: string): ThreadClassification {
  const now = Date.now();
  const lastMs = thread.dateRange.last.getTime();
  const actionable = now - lastMs <= TWELVE_MONTHS_MS;

  return {
    threadId: thread.threadId,
    category,
    confidence: 1.0,
    actionable,
    summary: "",
    classifiedBy: "rule",
    ruleName,
  };
}
