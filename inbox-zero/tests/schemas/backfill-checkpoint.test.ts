import { describe, expect, it } from "vitest";
import {
  BackfillCheckpointSchema,
  BackfillResidualErrorSchema,
  BackfillStatusSchema,
} from "../../src/schemas/backfill-checkpoint.js";

const validComplete = {
  runId: "backfill-2024-03-15-001",
  status: "complete" as const,
  sourceCheckpointLastSavedAt: "2024-03-15T10:00:00.000Z",
  sourceErrorFingerprint: "sha256-abc123def456",
  targetIds: ["msg-001", "msg-002", "msg-003"],
  recoveredCount: 2,
  residualErrors: [
    {
      messageId: "msg-003",
      error: "Message permanently deleted",
      timestamp: "2024-03-15T11:30:00.000Z",
    },
  ],
  shardsWritten: 1,
  lastSavedAt: "2024-03-15T12:00:00.000Z",
};

const validFetching = {
  runId: "backfill-2024-03-15-002",
  status: "fetching" as const,
  sourceCheckpointLastSavedAt: "2024-03-15T08:00:00.000Z",
  sourceErrorFingerprint: "sha256-xyz789",
  targetIds: ["msg-100", "msg-101"],
  lastSavedAt: "2024-03-15T08:05:00.000Z",
};

describe("BackfillStatusSchema", () => {
  it("accepts all valid status values", () => {
    const validValues = ["fetching", "promoting", "complete", "failed"] as const;
    for (const value of validValues) {
      expect(BackfillStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects invalid status values", () => {
    expect(() => BackfillStatusSchema.parse("running")).toThrow();
    expect(() => BackfillStatusSchema.parse("in_progress")).toThrow();
    expect(() => BackfillStatusSchema.parse("")).toThrow();
  });
});

describe("BackfillCheckpointSchema — valid inputs", () => {
  it("parses a valid complete backfill checkpoint", () => {
    const result = BackfillCheckpointSchema.parse(validComplete);
    expect(result.runId).toBe("backfill-2024-03-15-001");
    expect(result.status).toBe("complete");
    expect(result.sourceCheckpointLastSavedAt).toBeInstanceOf(Date);
    expect(result.sourceErrorFingerprint).toBe("sha256-abc123def456");
    expect(result.targetIds).toEqual(["msg-001", "msg-002", "msg-003"]);
    expect(result.recoveredCount).toBe(2);
    expect(result.residualErrors).toHaveLength(1);
    const firstError = result.residualErrors[0];
    if (firstError === undefined) throw new Error("Expected at least one residual error");
    expect(firstError.messageId).toBe("msg-003");
    expect(firstError.error).toBe("Message permanently deleted");
    expect(firstError.timestamp).toBeInstanceOf(Date);
    expect(result.shardsWritten).toBe(1);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
  });

  it("parses a valid fetching backfill checkpoint", () => {
    const result = BackfillCheckpointSchema.parse(validFetching);
    expect(result.runId).toBe("backfill-2024-03-15-002");
    expect(result.status).toBe("fetching");
    expect(result.sourceCheckpointLastSavedAt).toBeInstanceOf(Date);
    expect(result.sourceErrorFingerprint).toBe("sha256-xyz789");
    expect(result.targetIds).toEqual(["msg-100", "msg-101"]);
    expect(result.recoveredCount).toBe(0);
    expect(result.residualErrors).toEqual([]);
    expect(result.shardsWritten).toBe(0);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
  });

  it("defaults recoveredCount to 0 when omitted", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "recoveredCount"));
    const result = BackfillCheckpointSchema.parse(input);
    expect(result.recoveredCount).toBe(0);
  });

  it("defaults residualErrors to empty array when omitted", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "residualErrors"));
    const result = BackfillCheckpointSchema.parse(input);
    expect(result.residualErrors).toEqual([]);
  });

  it("defaults shardsWritten to 0 when omitted", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "shardsWritten"));
    const result = BackfillCheckpointSchema.parse(input);
    expect(result.shardsWritten).toBe(0);
  });

  it("coerces lastSavedAt from ISO string to Date", () => {
    const result = BackfillCheckpointSchema.parse(validComplete);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
    expect(result.lastSavedAt.getFullYear()).toBe(2024);
  });

  it("coerces sourceCheckpointLastSavedAt from ISO string to Date", () => {
    const result = BackfillCheckpointSchema.parse(validComplete);
    expect(result.sourceCheckpointLastSavedAt).toBeInstanceOf(Date);
    expect(result.sourceCheckpointLastSavedAt.getFullYear()).toBe(2024);
  });

  it("accepts Date instances for date fields", () => {
    const input = {
      ...validComplete,
      sourceCheckpointLastSavedAt: new Date("2024-03-15T10:00:00.000Z"),
      lastSavedAt: new Date("2024-03-15T12:00:00.000Z"),
    };
    const result = BackfillCheckpointSchema.parse(input);
    expect(result.sourceCheckpointLastSavedAt).toBeInstanceOf(Date);
    expect(result.lastSavedAt).toBeInstanceOf(Date);
  });
});

describe("BackfillCheckpointSchema — invalid inputs", () => {
  it("rejects missing runId", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "runId"));
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects empty runId", () => {
    const input = { ...validComplete, runId: "" };
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects invalid status value", () => {
    const input = { ...validComplete, status: "running" };
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing targetIds", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "targetIds"));
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing sourceErrorFingerprint", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "sourceErrorFingerprint"));
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing sourceCheckpointLastSavedAt", () => {
    const input = Object.fromEntries(
      Object.entries(validComplete).filter(([k]) => k !== "sourceCheckpointLastSavedAt"),
    );
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects missing lastSavedAt", () => {
    const input = Object.fromEntries(Object.entries(validComplete).filter(([k]) => k !== "lastSavedAt"));
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects negative recoveredCount", () => {
    const input = { ...validComplete, recoveredCount: -1 };
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects fractional recoveredCount", () => {
    const input = { ...validComplete, recoveredCount: 1.5 };
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });

  it("rejects negative shardsWritten", () => {
    const input = { ...validComplete, shardsWritten: -3 };
    expect(() => BackfillCheckpointSchema.parse(input)).toThrow();
  });
});

describe("BackfillResidualErrorSchema", () => {
  it("validates residual error entries have messageId, error, timestamp", () => {
    const valid = {
      messageId: "msg-999",
      error: "Rate limit exceeded",
      timestamp: "2024-03-15T09:00:00.000Z",
    };
    const result = BackfillResidualErrorSchema.parse(valid);
    expect(result.messageId).toBe("msg-999");
    expect(result.error).toBe("Rate limit exceeded");
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it("rejects residual error with empty messageId", () => {
    const input = {
      messageId: "",
      error: "Some error",
      timestamp: "2024-03-15T09:00:00.000Z",
    };
    expect(() => BackfillResidualErrorSchema.parse(input)).toThrow();
  });

  it("rejects residual error missing messageId", () => {
    const input = {
      error: "Some error",
      timestamp: "2024-03-15T09:00:00.000Z",
    };
    expect(() => BackfillResidualErrorSchema.parse(input)).toThrow();
  });

  it("rejects residual error missing error field", () => {
    const input = {
      messageId: "msg-999",
      timestamp: "2024-03-15T09:00:00.000Z",
    };
    expect(() => BackfillResidualErrorSchema.parse(input)).toThrow();
  });

  it("rejects residual error missing timestamp", () => {
    const input = {
      messageId: "msg-999",
      error: "Some error",
    };
    expect(() => BackfillResidualErrorSchema.parse(input)).toThrow();
  });

  it("coerces timestamp from ISO string to Date", () => {
    const input = {
      messageId: "msg-888",
      error: "timeout",
      timestamp: "2024-06-01T12:00:00.000Z",
    };
    const result = BackfillResidualErrorSchema.parse(input);
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.timestamp.getFullYear()).toBe(2024);
  });
});
