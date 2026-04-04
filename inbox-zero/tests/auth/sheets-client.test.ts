import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSheetsApi } from "../helpers/test-utils.js";

const ORIGINAL_ENV = { ...process.env };

vi.mock("googleapis", () => {
  class MockGoogleAuth {
    scopes: string[];

    constructor(opts: { scopes?: string[] } = {}) {
      this.scopes = opts.scopes ?? [];
    }
  }

  return {
    google: {
      auth: {
        GoogleAuth: MockGoogleAuth,
      },
      sheets: vi.fn(),
    },
  };
});

import { google } from "googleapis";
import { createSheetsClient } from "../../src/auth/sheets-client.js";

function getSheetsMock(): ReturnType<typeof vi.fn> {
  return google.sheets as unknown as ReturnType<typeof vi.fn>;
}

describe("createSheetsClient()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    delete process.env.GMAIL_USER;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails fast when service-account mode is enabled without GMAIL_USER", async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "/tmp/fake-key.json";

    await expect(createSheetsClient()).rejects.toThrow(
      "GMAIL_USER is required when GOOGLE_SERVICE_ACCOUNT_KEY is set",
    );
  });

  it("returns an error when the Sheets API create call omits spreadsheetId", async () => {
    const mockApi = createMockSheetsApi({
      spreadsheet: {
        spreadsheetId: undefined,
      },
    });
    getSheetsMock().mockReturnValue(mockApi);

    const client = await createSheetsClient();
    const result = await client.createSpreadsheet("Audit");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected error result");
    }
    expect(result.error).toMatch(/spreadsheetId/i);
  });
});
