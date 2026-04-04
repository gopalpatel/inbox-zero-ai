/**
 * SheetsReporter — orchestrates creation of a Gmail audit spreadsheet.
 *
 * Responsibilities:
 * 1. Create a new Google Sheet titled "Gmail Audit — YYYY-MM-DD".
 * 2. Write the spec-mandated 16-column header row.
 * 3. Write one data row per SenderStats entry.
 * 4. Apply formatting: bold header, frozen row, auto-filter.
 * 5. Add data validation on "Your decision" column (keep/filter/unsubscribe).
 * 6. Create a Dashboard tab with summary progress metrics.
 */

import type { SheetsClient } from "../auth/sheets-client.js";
import type { SenderStats } from "../schemas/sender-stats.js";
import type { Result } from "../types.js";
import { formatYMD } from "../utils.js";

// ---------------------------------------------------------------------------
// Header row — single source of truth for column layout
// ---------------------------------------------------------------------------

/**
 * The 16-column header row for the Gmail audit spreadsheet.
 * Column order matches the spec exactly.
 * Columns 1-13 are the original audit columns.
 * Columns 14-16 (indices 13-15) are enrichment additions: Sender type,
 * Extraction candidate, and Processed (populated later by execute-batch).
 */
export const AUDIT_HEADER_ROW: readonly string[] = [
  "Sender email",
  "Sender name",
  "Email count",
  "First email date",
  "Last email date",
  "Gmail category",
  "Unread ratio",
  "Thread count",
  "Sample subjects",
  "Confidence tier",
  "Recommended action",
  "Surprises flag",
  "Your decision",
  "Sender type",
  "Extraction candidate",
  "Processed",
];

/**
 * Zero-based column index of the "Your decision" column.
 * Used for data validation range targeting.
 */
function requiredHeaderIndex(header: string): number {
  const index = AUDIT_HEADER_ROW.indexOf(header);
  if (index === -1) {
    throw new Error(`AUDIT_HEADER_ROW is missing "${header}"`);
  }
  return index;
}

const YOUR_DECISION_COL_INDEX = requiredHeaderIndex("Your decision");
const UNREAD_RATIO_COL_INDEX = requiredHeaderIndex("Unread ratio");
const DASHBOARD_SHEET_ID = 1;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats today's date as a YYYY-MM-DD string (UTC).
 * Delegates to the shared `formatYMD` utility.
 */
function todayAsYMD(): string {
  return formatYMD(new Date());
}

// ---------------------------------------------------------------------------
// Row serialisation
// ---------------------------------------------------------------------------

/**
 * Converts a `SenderStats` object into the 16-element row array
 * that maps to the `AUDIT_HEADER_ROW` columns.
 *
 * Columns 1-13 are the original audit fields.
 * Columns 14-16 are enrichment additions:
 * - Sender type: senderType value or empty string
 * - Extraction candidate: "Yes" / "No" / "" (absent)
 * - Processed: always empty — populated later by execute-batch
 */
function statsToRow(stats: SenderStats): unknown[] {
  return [
    stats.senderEmail,
    stats.senderName,
    stats.emailCount,
    stats.firstEmailDate,
    stats.lastEmailDate,
    stats.gmailCategory,
    stats.unreadRatio,
    stats.threadCount,
    stats.sampleSubjects.join(" | "),
    stats.confidenceTier ?? "",
    stats.recommendedAction ?? "",
    stats.surprisesFlag ? "Yes" : "No",
    stats.userDecision ?? "",
    stats.senderType ?? "",
    stats.extractionCandidate === true ? "Yes" : stats.extractionCandidate === false ? "No" : "",
    "", // Processed — populated later by execute-batch
  ];
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Creates a complete Gmail audit spreadsheet from a list of `SenderStats`.
 *
 * Steps:
 * 1. Create a new spreadsheet titled "Gmail Audit — YYYY-MM-DD".
 * 2. Write the 16-column header row to Sheet1!A1.
 * 3. Write all data rows starting at Sheet1!A2.
 * 4. Apply formatting: bold header, frozen row 1, auto-filter.
 * 5. Add data validation dropdown on the "Your decision" column.
 * 6. Add a "Dashboard" tab with summary progress metrics (Dashboard!A1:B7).
 *
 * @param stats   Array of SenderStats to write as rows.
 * @param client  Authenticated SheetsClient for Google Sheets API calls.
 * @param title   Optional spreadsheet title. Defaults to "Gmail Audit — YYYY-MM-DD".
 * @returns `Result<{ spreadsheetId, spreadsheetUrl }>` — never throws.
 */
export async function createAuditReport(
  stats: SenderStats[],
  client: SheetsClient,
  title?: string,
): Promise<Result<{ spreadsheetId: string; spreadsheetUrl: string }>> {
  try {
    // ----------------------------------------------------------------
    // Step 1: Create the spreadsheet
    // ----------------------------------------------------------------
    const sheetTitle = title ?? `Gmail Audit — ${todayAsYMD()}`;

    const createResult = await client.createSpreadsheet(sheetTitle);
    if (!createResult.ok) {
      return createResult;
    }

    const { spreadsheetId, spreadsheetUrl } = createResult.value;

    // ----------------------------------------------------------------
    // Step 2: Write header row
    // ----------------------------------------------------------------
    const headerResult = await client.writeRows(spreadsheetId, "Sheet1!A1", [Array.from(AUDIT_HEADER_ROW)]);
    if (!headerResult.ok) {
      return headerResult;
    }

    // ----------------------------------------------------------------
    // Step 3: Write data rows (only if there are stats to write)
    // ----------------------------------------------------------------
    if (stats.length > 0) {
      const dataRows = stats.map(statsToRow);
      const dataResult = await client.writeRows(spreadsheetId, "Sheet1!A2", dataRows);
      if (!dataResult.ok) {
        return dataResult;
      }
    }

    // ----------------------------------------------------------------
    // Step 4 + 5: Format and validate Sheet1, then add Dashboard tab
    // ----------------------------------------------------------------

    /** The sheetId for the first sheet (always 0 for new spreadsheets). */
    const SHEET_ID = 0;

    /** Total number of audit columns. */
    const TOTAL_COLS = AUDIT_HEADER_ROW.length;

    /**
     * Dashboard metrics row count.
     * Rows: Total senders, Processed, Emails cleared, Unsubscribed,
     *       Filters created, Remaining, Current section.
     */
    const DASHBOARD_ROW_COUNT = 7;

    const formatResult = await client.formatSheet(spreadsheetId, [
      // Bold the header row in Sheet1
      {
        repeatCell: {
          range: {
            sheetId: SHEET_ID,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: TOTAL_COLS,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
      // Freeze row 1 in Sheet1
      {
        updateSheetProperties: {
          properties: {
            sheetId: SHEET_ID,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "gridProperties.frozenRowCount",
        },
      },
      // Enable auto-filter starting from the header row
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: SHEET_ID,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: TOTAL_COLS,
            },
          },
        },
      },
      // Data validation for "Your decision" column (dropdown)
      {
        setDataValidation: {
          range: {
            sheetId: SHEET_ID,
            startRowIndex: 1, // skip header row
            startColumnIndex: YOUR_DECISION_COL_INDEX,
            endColumnIndex: YOUR_DECISION_COL_INDEX + 1,
          },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: [
                { userEnteredValue: "keep" },
                { userEnteredValue: "filter" },
                { userEnteredValue: "unsubscribe" },
              ],
            },
            showCustomUi: true,
            strict: true,
          },
        },
      },
      // Format the "Unread ratio" column as percentage (so the raw number 0.85 displays as 85%)
      {
        repeatCell: {
          range: {
            sheetId: SHEET_ID,
            startRowIndex: 1,
            startColumnIndex: UNREAD_RATIO_COL_INDEX,
            endColumnIndex: UNREAD_RATIO_COL_INDEX + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "PERCENT", pattern: "0%" },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      // Add the Dashboard tab with an explicit sheetId so later requests can target it safely.
      {
        addSheet: {
          properties: {
            title: "Dashboard",
            sheetId: DASHBOARD_SHEET_ID,
          },
        },
      },
      // Bold the labels column (column A) in the Dashboard tab.
      {
        repeatCell: {
          range: {
            sheetId: DASHBOARD_SHEET_ID,
            startRowIndex: 0,
            endRowIndex: DASHBOARD_ROW_COUNT,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
    ]);

    if (!formatResult.ok) {
      return formatResult;
    }

    // ----------------------------------------------------------------
    // Step 6: Write Dashboard summary metrics
    // ----------------------------------------------------------------

    const totalSenders = stats.length;
    const dashboardRows: unknown[][] = [
      ["Total senders", totalSenders],
      ["Processed", 0],
      ["Emails cleared", 0],
      ["Unsubscribed", 0],
      ["Filters created", 0],
      ["Remaining", totalSenders],
      ["Current section", "—"],
    ];

    const dashboardResult = await client.writeRows(spreadsheetId, "Dashboard!A1:B7", dashboardRows);
    if (!dashboardResult.ok) {
      return dashboardResult;
    }

    return { ok: true, value: { spreadsheetId, spreadsheetUrl } };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
