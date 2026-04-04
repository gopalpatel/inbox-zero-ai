/**
 * SheetsClient — thin wrapper around Google Sheets v4 API.
 *
 * Uses `google.auth.getApplicationDefault()` for authentication,
 * matching the same auth strategy as GmailClient.
 * All public methods return `Result<T>` so callers never receive raw exceptions.
 */

import type { sheets_v4 } from "googleapis";
import { google } from "googleapis";

export type { Result } from "../types.js";

import type { Result } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// SheetsClient interface
// ---------------------------------------------------------------------------

export interface SheetsClient {
  /** Creates a new spreadsheet with the given title. */
  createSpreadsheet(title: string): Promise<Result<{ spreadsheetId: string; spreadsheetUrl: string }>>;

  /** Writes a 2-D array of values to the given range (valueInputOption: RAW). */
  writeRows(spreadsheetId: string, range: string, values: unknown[][]): Promise<Result<void>>;

  /** Reads rows from the given range. Returns an empty array if no data found. */
  readRows(spreadsheetId: string, range: string): Promise<Result<unknown[][]>>;

  /** Applies an array of formatting/validation requests via spreadsheets.batchUpdate. */
  formatSheet(spreadsheetId: string, requests: sheets_v4.Schema$Request[]): Promise<Result<void>>;
}

// ---------------------------------------------------------------------------
// Core SheetsClient implementation
// ---------------------------------------------------------------------------

class SheetsClientImpl implements SheetsClient {
  private readonly api: sheets_v4.Sheets;

  constructor(api: sheets_v4.Sheets) {
    this.api = api;
  }

  async createSpreadsheet(title: string): Promise<Result<{ spreadsheetId: string; spreadsheetUrl: string }>> {
    try {
      const response = await this.api.spreadsheets.create({
        requestBody: {
          properties: { title },
        },
      });
      const spreadsheetId = response.data.spreadsheetId;
      if (!spreadsheetId) {
        return { ok: false, error: "Sheets API did not return spreadsheetId" };
      }
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      return { ok: true, value: { spreadsheetId, spreadsheetUrl } };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async writeRows(spreadsheetId: string, range: string, values: unknown[][]): Promise<Result<void>> {
    try {
      await this.api.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values },
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async readRows(spreadsheetId: string, range: string): Promise<Result<unknown[][]>> {
    try {
      const response = await this.api.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      return { ok: true, value: response.data.values ?? [] };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async formatSheet(spreadsheetId: string, requests: sheets_v4.Schema$Request[]): Promise<Result<void>> {
    try {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a `SheetsClient` authenticated via Application Default Credentials.
 *
 * @example
 * ```ts
 * const client = await createSheetsClient();
 * const result = await client.createSpreadsheet("My Report");
 * if (result.ok) console.log(result.value.spreadsheetUrl);
 * ```
 */
export async function createSheetsClient(): Promise<SheetsClient> {
  const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

  const keyFile = process.env["GOOGLE_SERVICE_ACCOUNT_KEY"];
  const impersonateUser = process.env["GOOGLE_IMPERSONATE_USER"];

  let auth: InstanceType<typeof google.auth.GoogleAuth>;
  if (keyFile !== undefined && keyFile.length > 0) {
    if (!impersonateUser) {
      throw new Error("GOOGLE_IMPERSONATE_USER is required when GOOGLE_SERVICE_ACCOUNT_KEY is set");
    }

    // Service account with domain-wide delegation — bypasses RAPT token expiry
    auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: SHEETS_SCOPES,
      clientOptions: { subject: impersonateUser },
    });
  } else {
    // Application Default Credentials (gcloud auth)
    auth = new google.auth.GoogleAuth({
      scopes: SHEETS_SCOPES,
    });
  }

  const api = google.sheets({
    version: "v4",
    auth,
  });

  return new SheetsClientImpl(api);
}
