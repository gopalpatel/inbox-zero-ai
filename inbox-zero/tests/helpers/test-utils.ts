import type { gmail_v1, sheets_v4 } from "googleapis";
import { vi } from "vitest";

/**
 * A GaxiosResponse-shaped stub. The real API returns `{ data: T, status: number, ... }`.
 * We only need the `data` field for our production code.
 */
function makeResponse<T>(data: T): {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  config: Record<string, unknown>;
} {
  return { data, status: 200, statusText: "OK", headers: {}, config: {} };
}

// ---------------------------------------------------------------------------
// Gmail mock shapes
// ---------------------------------------------------------------------------

export interface MockGmailMessages {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  batchModify: ReturnType<typeof vi.fn>;
}

export interface MockGmailLabels {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

export interface MockGmailFilters {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

export interface MockGmailSettings {
  filters: MockGmailFilters;
}

export interface MockGmailUsers {
  getProfile: ReturnType<typeof vi.fn>;
  messages: MockGmailMessages;
  labels: MockGmailLabels;
  settings: MockGmailSettings;
}

export interface MockGmailApi {
  users: MockGmailUsers;
}

/**
 * Partial overrides that can be passed per test to override specific mock responses.
 * Each value is the resolved data (not the full response wrapper).
 */
export interface GmailApiOverrides {
  profile?: Partial<gmail_v1.Schema$Profile>;
  listMessages?: Partial<gmail_v1.Schema$ListMessagesResponse>;
  getMessage?: Partial<gmail_v1.Schema$Message>;
  listLabels?: Partial<gmail_v1.Schema$ListLabelsResponse>;
  createLabel?: Partial<gmail_v1.Schema$Label>;
  createFilter?: Partial<gmail_v1.Schema$Filter>;
  listFilters?: Partial<gmail_v1.Schema$ListFiltersResponse>;
}

/**
 * Factory that creates a fully mocked Gmail API object that mirrors the
 * `gmail_v1.Gmail` structure. Each method resolves with an empty/default
 * response. Pass `overrides` to control specific return values per test.
 */
export function createMockGmailApi(overrides: GmailApiOverrides = {}): MockGmailApi {
  const profile: gmail_v1.Schema$Profile = {
    emailAddress: "test@example.com",
    messagesTotal: 0,
    threadsTotal: 0,
    historyId: "1",
    ...overrides.profile,
  };

  const listMessagesResponse: gmail_v1.Schema$ListMessagesResponse = {
    messages: [],
    nextPageToken: undefined,
    resultSizeEstimate: 0,
    ...overrides.listMessages,
  };

  const message: gmail_v1.Schema$Message = {
    id: "msg-001",
    threadId: "thread-001",
    labelIds: [],
    snippet: "",
    historyId: "1",
    internalDate: "0",
    payload: undefined,
    ...overrides.getMessage,
  };

  const listLabelsResponse: gmail_v1.Schema$ListLabelsResponse = {
    labels: [],
    ...overrides.listLabels,
  };

  const label: gmail_v1.Schema$Label = {
    id: "label-001",
    name: "TestLabel",
    ...overrides.createLabel,
  };

  const filter: gmail_v1.Schema$Filter = {
    id: "filter-001",
    criteria: {},
    action: {},
    ...overrides.createFilter,
  };

  const listFiltersResponse: gmail_v1.Schema$ListFiltersResponse = {
    filter: [],
    ...overrides.listFilters,
  };

  return {
    users: {
      getProfile: vi.fn().mockResolvedValue(makeResponse(profile)),
      messages: {
        list: vi.fn().mockResolvedValue(makeResponse(listMessagesResponse)),
        get: vi.fn().mockResolvedValue(makeResponse(message)),
        batchModify: vi.fn().mockResolvedValue(makeResponse(undefined)),
      },
      labels: {
        list: vi.fn().mockResolvedValue(makeResponse(listLabelsResponse)),
        create: vi.fn().mockResolvedValue(makeResponse(label)),
      },
      settings: {
        filters: {
          list: vi.fn().mockResolvedValue(makeResponse(listFiltersResponse)),
          create: vi.fn().mockResolvedValue(makeResponse(filter)),
          delete: vi.fn().mockResolvedValue(makeResponse(undefined)),
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Sheets mock shapes (for future use)
// ---------------------------------------------------------------------------

export interface MockSheetsSpreadsheets {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  /** Top-level spreadsheets.batchUpdate — used for formatting, data validation, etc. */
  batchUpdate: ReturnType<typeof vi.fn>;
  values: {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    batchUpdate: ReturnType<typeof vi.fn>;
    batchGet: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
}

export interface MockSheetsApi {
  spreadsheets: MockSheetsSpreadsheets;
}

export interface SheetsApiOverrides {
  spreadsheet?: Partial<sheets_v4.Schema$Spreadsheet>;
  valuesGetResponse?: Partial<sheets_v4.Schema$ValueRange>;
  valuesUpdateResponse?: Partial<sheets_v4.Schema$UpdateValuesResponse>;
  valuesAppendResponse?: Partial<sheets_v4.Schema$AppendValuesResponse>;
}

/**
 * Factory that creates a fully mocked Sheets API object that mirrors the
 * `sheets_v4.Sheets` structure. Each method resolves with an empty/default
 * response. Pass `overrides` to control specific return values per test.
 */
export function createMockSheetsApi(overrides: SheetsApiOverrides = {}): MockSheetsApi {
  const spreadsheet: sheets_v4.Schema$Spreadsheet = {
    spreadsheetId: "spreadsheet-001",
    sheets: [],
    ...overrides.spreadsheet,
  };

  const valuesGetResponse: sheets_v4.Schema$ValueRange = {
    range: "Sheet1!A1:Z1000",
    majorDimension: "ROWS",
    values: [],
    ...overrides.valuesGetResponse,
  };

  const valuesUpdateResponse: sheets_v4.Schema$UpdateValuesResponse = {
    spreadsheetId: "spreadsheet-001",
    updatedRange: "Sheet1!A1",
    updatedRows: 0,
    updatedColumns: 0,
    updatedCells: 0,
    ...overrides.valuesUpdateResponse,
  };

  const valuesAppendResponse: sheets_v4.Schema$AppendValuesResponse = {
    spreadsheetId: "spreadsheet-001",
    tableRange: "Sheet1!A1",
    ...overrides.valuesAppendResponse,
  };

  return {
    spreadsheets: {
      get: vi.fn().mockResolvedValue(makeResponse(spreadsheet)),
      create: vi.fn().mockResolvedValue(makeResponse(spreadsheet)),
      batchUpdate: vi.fn().mockResolvedValue(makeResponse({})),
      values: {
        get: vi.fn().mockResolvedValue(makeResponse(valuesGetResponse)),
        update: vi.fn().mockResolvedValue(makeResponse(valuesUpdateResponse)),
        append: vi.fn().mockResolvedValue(makeResponse(valuesAppendResponse)),
        batchUpdate: vi.fn().mockResolvedValue(makeResponse({})),
        batchGet: vi.fn().mockResolvedValue(makeResponse({ valueRanges: [] })),
        clear: vi.fn().mockResolvedValue(makeResponse({})),
      },
    },
  };
}
