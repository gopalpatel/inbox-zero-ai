/**
 * Shared constants for Gmail metadata pull and backfill operations.
 *
 * Centralised here so metadata-puller.ts and backfill.ts use identical
 * API request parameters without duplicating magic values.
 */

/**
 * Metadata headers to request from the Gmail API.
 * Requesting only these four headers keeps the payload small.
 */
export const METADATA_HEADERS = ["From", "To", "Cc", "Subject"] as const;

/**
 * Maximum number of concurrent getMessage calls.
 * Gmail API allows 250 quota units/sec; messages.get costs 5 units each,
 * so the theoretical max is ~50 concurrent. We use 40 to stay safely
 * under the limit while significantly improving throughput.
 */
export const MAX_CONCURRENT = 40;
