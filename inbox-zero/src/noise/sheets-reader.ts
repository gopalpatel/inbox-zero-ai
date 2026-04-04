/**
 * SheetsReader — reads user decisions from the Gmail audit Google Sheet.
 *
 * Reads the "Your decision" column (index 12, 0-based) from the audit report
 * produced by SheetsReporter. Returns a Map<senderEmail, UserDecision>.
 *
 * Design decisions:
 * - Skips rows where the decision column is empty or absent.
 * - Performs case-insensitive parsing ("Keep" → "keep").
 * - Returns { ok: false } on invalid decision values instead of silently ignoring them.
 */

import { AUDIT_HEADER_ROW } from "../analysis/sheets-reporter.js";
import type { SheetsClient } from "../auth/sheets-client.js";
import type { Result } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three valid user decisions from the audit sheet. */
export type UserDecision = "keep" | "filter" | "unsubscribe";

/**
 * The valid decisions as a Set for O(1) lookup.
 * Using lowercase strings since we normalise before checking.
 */
const VALID_DECISIONS = new Set<string>(["keep", "filter", "unsubscribe"]);

// ---------------------------------------------------------------------------
// Column indices (0-based) — derived from AUDIT_HEADER_ROW
// ---------------------------------------------------------------------------

/** Sender email column index, derived from the canonical header row. */
const SENDER_EMAIL_COL = AUDIT_HEADER_ROW.indexOf("Sender email");

/** "Your decision" column index, derived from the canonical header row. */
const DECISION_COL = AUDIT_HEADER_ROW.indexOf("Your decision");

if (SENDER_EMAIL_COL < 0 || DECISION_COL < 0) {
  throw new Error("Audit header row is missing required columns (Sender email or Your decision)");
}

/** The range to read — covers all columns including "Your decision". */
const AUDIT_RANGE = "Sheet1!A:M";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reads user decisions from the Google Sheets audit report.
 *
 * @param client - Authenticated SheetsClient.
 * @param spreadsheetId - ID of the audit spreadsheet.
 * @returns `Result<Map<senderEmail, UserDecision>>` — never throws.
 */
export async function readDecisions(
  client: SheetsClient,
  spreadsheetId: string,
): Promise<Result<Map<string, UserDecision>>> {
  const rowsResult = await client.readRows(spreadsheetId, AUDIT_RANGE);

  if (!rowsResult.ok) {
    return { ok: false, error: rowsResult.error };
  }

  const rows = rowsResult.value;

  /** Skip row 0 (header). */
  const dataRows = rows.slice(1);

  const decisions = new Map<string, UserDecision>();

  for (const row of dataRows) {
    // Skip rows too short to have the decision column.
    if (row.length <= DECISION_COL) continue;

    const rawDecision = row[DECISION_COL];

    // Skip rows where the decision cell is empty/absent.
    if (rawDecision === "" || rawDecision === null || rawDecision === undefined) continue;

    const decisionStr = String(rawDecision).trim().toLowerCase();

    // Skip blank after trim.
    if (decisionStr === "") continue;

    if (!VALID_DECISIONS.has(decisionStr)) {
      const senderEmail = String(row[SENDER_EMAIL_COL] ?? "").trim();
      return {
        ok: false,
        error: `Invalid decision "${String(rawDecision)}" for sender "${senderEmail}". Must be one of: keep, filter, unsubscribe.`,
      };
    }

    const senderEmail = String(row[SENDER_EMAIL_COL] ?? "").trim();
    if (senderEmail !== "") {
      decisions.set(senderEmail, decisionStr as UserDecision);
    }
  }

  return { ok: true, value: decisions };
}
