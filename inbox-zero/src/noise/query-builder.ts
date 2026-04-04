/**
 * Shared query-building utilities for Gmail OR-based sender queries.
 * Used by both the sweep module and the filter consolidator.
 */

/** Separator between OR-ed from clauses in Gmail queries. */
export const OR_SEPARATOR = " OR ";

/** Fragment prefix for each sender in a query. */
export const FROM_PREFIX = "from:";

/** Default maximum characters per Gmail query string. */
export const DEFAULT_MAX_QUERY_CHARS = 1200;

/** A planned OR query together with the sender addresses it covers. */
export interface OrQueryPlan {
  senders: string[];
  query: string;
}

/** Options for {@link buildOrQueries} and {@link buildOrQueryPlans}. */
export interface BuildOrQueriesOptions {
  maxChars?: number;
  maxSendersPerBatch?: number;
  wrapQuery?: (inner: string) => string;
}

/**
 * Groups sender emails into batched `from:` OR queries, respecting both
 * a character-length cap and an optional sender-count cap.
 *
 * Each returned string is a complete query. By default returns bare queries
 * like `from:a@x.com OR from:b@y.com`. Pass `wrapQuery` to add surrounding
 * syntax (e.g., `in:inbox (...)`).
 *
 * Guarantees at least one sender per batch, even if it exceeds maxChars.
 */
export function buildOrQueryPlans(
  senderEmails: string[],
  options?: BuildOrQueriesOptions,
): OrQueryPlan[] {
  if (senderEmails.length === 0) return [];

  const maxChars = options?.maxChars ?? DEFAULT_MAX_QUERY_CHARS;
  const maxSendersPerBatch = options?.maxSendersPerBatch;

  if (maxChars <= 0) {
    throw new RangeError("buildOrQueries: maxChars must be positive");
  }
  if (maxSendersPerBatch !== undefined && maxSendersPerBatch <= 0) {
    throw new RangeError("buildOrQueries: maxSendersPerBatch must be positive");
  }
  const wrapQuery = options?.wrapQuery;

  // When wrapQuery is provided, we need to account for the wrapper overhead
  // in our character budget. Measure by wrapping an empty string.
  const wrapperOverhead = wrapQuery !== undefined ? wrapQuery("").length : 0;

  const plans: OrQueryPlan[] = [];
  let currentClauses: string[] = [];
  let currentSenders: string[] = [];
  let currentLength = wrapperOverhead;

  for (const email of senderEmails) {
    const clause = `${FROM_PREFIX}${email}`;
    const separatorLength = currentClauses.length > 0 ? OR_SEPARATOR.length : 0;
    const candidateLength = currentLength + separatorLength + clause.length;

    const wouldExceedSenderCap =
      maxSendersPerBatch !== undefined && currentClauses.length >= maxSendersPerBatch;
    const wouldExceedCharCap =
      candidateLength > maxChars && currentClauses.length > 0;

    if (wouldExceedSenderCap || wouldExceedCharCap) {
      // Flush current batch
      const inner = currentClauses.join(OR_SEPARATOR);
      plans.push({
        senders: currentSenders,
        query: wrapQuery !== undefined ? wrapQuery(inner) : inner,
      });
      currentClauses = [];
      currentSenders = [];
      currentLength = wrapperOverhead;
    }

    // Add the sender to the current batch
    const sep = currentClauses.length > 0 ? OR_SEPARATOR.length : 0;
    currentClauses.push(clause);
    currentSenders.push(email);
    currentLength += sep + clause.length;
  }

  // Flush remaining
  if (currentClauses.length > 0) {
    const inner = currentClauses.join(OR_SEPARATOR);
    plans.push({
      senders: currentSenders,
      query: wrapQuery !== undefined ? wrapQuery(inner) : inner,
    });
  }

  return plans;
}

/** Thin wrapper around {@link buildOrQueryPlans} that returns only the query strings. */
export function buildOrQueries(
  senderEmails: string[],
  options?: BuildOrQueriesOptions,
): string[] {
  return buildOrQueryPlans(senderEmails, options).map((plan) => plan.query);
}
