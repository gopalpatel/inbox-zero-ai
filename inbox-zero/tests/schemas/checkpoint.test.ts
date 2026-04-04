import { describe, expect, it } from "vitest";
import { CheckpointErrorSchema, CheckpointSchema, CheckpointStatusSchema } from "../../src/schemas/checkpoint.js";

const validInProgress = {
  status: "in_progress" as const,
  query: "in:inbox after:2024/01/01",
  pageToken: "page-token-abc",
  messagesFetched: 150,
  batchesSaved: 3,
  lastSavedAt: "2024-03-15T10:30:00.000Z",
  errors: [],
};

const validComplete = {
  status: "complete" as const,
  query: "in:inbox after:2024/01/01",
  pageToken: null,
  messagesFetched: 500,
  batchesSaved: 10,
  lastSavedAt: new Date("2024-03-15T18:00:00.000Z"),
};

describe("CheckpointStatusSchema", () => {
  it("accepts all valid status values", () => {
    expect(CheckpointStatusSchema.parse("in_progress")).toBe("in_progress");
    expect(CheckpointStatusSchema.parse("complete")).toBe("complete");
    expect(CheckpointStatusSchema.parse("failed")).toBe("failed");
  });

  it("rejects invalid status values", () => {
    expect(() => CheckpointStatusSchema.parse("done")).toThrow();
    expect(() => CheckpointStatusSchema.parse("pending")).toThrow();
    expect(() => CheckpointStatusSchema.parse("")).toThrow();
  });
});

describe("CheckpointSchema — valid inputs", () => {
  it("parses a valid in_progress checkpoint with pageToken", () => {
    const result = CheckpointSchema.parse(validInProgress);
    expect(result.status).toBe("in_progress");
    expect(result.query).toBe("in:inbox after:2024/01/01");
    expect(result.pageToken).toBe("page-token-abc");
    expect(result.messagesFetched).toBe(150);
    expect(result.batchesSaved).toBe(3);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
    expect(result.errors).toEqual([]);
  });

  it("parses a valid complete checkpoint with null pageToken", () => {
    const result = CheckpointSchema.parse(validComplete);
    expect(result.status).toBe("complete");
    expect(result.pageToken).toBeNull();
    expect(result.messagesFetched).toBe(500);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
  });

  it("parses a failed checkpoint", () => {
    const input = {
      ...validInProgress,
      status: "failed" as const,
      errors: [
        {
          timestamp: "2024-03-15T09:00:00.000Z",
          message: "Rate limit exceeded",
          pageToken: "tok-99",
        },
      ],
    };
    const result = CheckpointSchema.parse(input);
    expect(result.status).toBe("failed");
    const firstError = result.errors[0];
    if (firstError === undefined) throw new Error("Expected at least one error");
    expect(firstError.timestamp).toBeInstanceOf(Date);
    expect(firstError.message).toBe("Rate limit exceeded");
    expect(firstError.pageToken).toBe("tok-99");
  });

  it("coerces lastSavedAt from ISO string to Date", () => {
    const result = CheckpointSchema.parse(validInProgress);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
    expect(result.lastSavedAt.getFullYear()).toBe(2024);
  });

  it("accepts Date instance for lastSavedAt", () => {
    const input = { ...validInProgress, lastSavedAt: new Date("2024-06-01") };
    const result = CheckpointSchema.parse(input);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
  });

  it("defaults errors to empty array when omitted", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "errors"));
    const result = CheckpointSchema.parse(input);
    expect(result.errors).toEqual([]);
  });

  it("defaults pageToken to null when omitted", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "pageToken"));
    const result = CheckpointSchema.parse(input);
    expect(result.pageToken).toBeNull();
  });

  it("coerces error timestamps from ISO strings", () => {
    const input = {
      ...validInProgress,
      errors: [{ timestamp: "2024-01-10T12:00:00.000Z", message: "timeout", pageToken: null }],
    };
    const result = CheckpointSchema.parse(input);
    const err = result.errors[0];
    if (err === undefined) throw new Error("Expected error entry");
    expect(err.timestamp).toBeInstanceOf(Date);
    expect(err.pageToken).toBeNull();
  });
});

describe("CheckpointSchema — invalid inputs", () => {
  it("rejects invalid status", () => {
    const input = { ...validInProgress, status: "running" };
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects negative messagesFetched", () => {
    const input = { ...validInProgress, messagesFetched: -1 };
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects fractional messagesFetched", () => {
    const input = { ...validInProgress, messagesFetched: 1.5 };
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects negative batchesSaved", () => {
    const input = { ...validInProgress, batchesSaved: -5 };
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing status", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "status"));
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing query", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "query"));
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing messagesFetched", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "messagesFetched"));
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing batchesSaved", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "batchesSaved"));
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing lastSavedAt", () => {
    const input = Object.fromEntries(Object.entries(validInProgress).filter(([k]) => k !== "lastSavedAt"));
    expect(() => CheckpointSchema.parse(input)).toThrow();
  });

  it("rejects zero messagesFetched as valid (0 is non-negative, should pass)", () => {
    const input = { ...validInProgress, messagesFetched: 0 };
    const result = CheckpointSchema.parse(input);
    expect(result.messagesFetched).toBe(0);
  });
});

describe("CheckpointErrorSchema — backward compatibility", () => {
  it("parses existing checkpoint without kind/messageId fields", () => {
    const input = {
      ...validInProgress,
      errors: [
        {
          timestamp: "2024-03-15T09:00:00.000Z",
          message: "Rate limit exceeded",
          pageToken: "tok-99",
        },
      ],
    };
    const result = CheckpointSchema.parse(input);
    const firstError = result.errors[0];
    if (firstError === undefined) throw new Error("Expected at least one error");
    expect(firstError.timestamp).toBeInstanceOf(Date);
    expect(firstError.message).toBe("Rate limit exceeded");
    expect(firstError.pageToken).toBe("tok-99");
    expect(firstError.kind).toBeUndefined();
    expect(firstError.messageId).toBeUndefined();
  });

  it("parses checkpoint with new kind and messageId fields", () => {
    const input = {
      ...validInProgress,
      errors: [
        {
          timestamp: "2024-03-15T09:00:00.000Z",
          message: "Failed to fetch message body",
          pageToken: null,
          kind: "message" as const,
          messageId: "abc123",
        },
      ],
    };
    const result = CheckpointSchema.parse(input);
    const firstError = result.errors[0];
    if (firstError === undefined) throw new Error("Expected at least one error");
    expect(firstError.kind).toBe("message");
    expect(firstError.messageId).toBe("abc123");
  });

  it("parses checkpoint with mixed old and new error entries", () => {
    const input = {
      ...validInProgress,
      errors: [
        {
          timestamp: "2024-03-15T08:00:00.000Z",
          message: "Timeout",
          pageToken: "tok-1",
        },
        {
          timestamp: "2024-03-15T09:00:00.000Z",
          message: "Message not found",
          pageToken: null,
          kind: "message" as const,
          messageId: "msg-456",
        },
        {
          timestamp: "2024-03-15T10:00:00.000Z",
          message: "Quota exceeded",
          pageToken: "tok-2",
          kind: "system" as const,
        },
      ],
    };
    const result = CheckpointSchema.parse(input);
    expect(result.errors).toHaveLength(3);

    const oldStyleError = result.errors[0]!;
    expect(oldStyleError.kind).toBeUndefined();
    expect(oldStyleError.messageId).toBeUndefined();

    const messageError = result.errors[1]!;
    expect(messageError.kind).toBe("message");
    expect(messageError.messageId).toBe("msg-456");

    const systemError = result.errors[2]!;
    expect(systemError.kind).toBe("system");
    expect(systemError.messageId).toBeUndefined();
  });

  it("rejects invalid kind value", () => {
    const input = {
      timestamp: "2024-03-15T09:00:00.000Z",
      message: "Bad error",
      pageToken: null,
      kind: "invalid",
    };
    expect(() => CheckpointErrorSchema.parse(input)).toThrow();
  });

  it("CheckpointErrorSchema accepts minimal error entry", () => {
    const input = {
      timestamp: "2024-03-15T09:00:00.000Z",
      message: "Something went wrong",
      pageToken: null,
    };
    const result = CheckpointErrorSchema.parse(input);
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.message).toBe("Something went wrong");
    expect(result.pageToken).toBeNull();
    expect(result.kind).toBeUndefined();
    expect(result.messageId).toBeUndefined();
  });
});
