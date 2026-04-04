/**
 * rule-engine.test.ts
 *
 * Tests for the deterministic rule engine that classifies threads before
 * falling back to the LLM classifier.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRulesTemplateFromAudit, classify, loadRules, type RulesConfig } from "../../src/classify/rule-engine.js";
import type { ThreadSummary } from "../../src/classify/thread-collapser.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory and returns its path. Caller is responsible for cleanup. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rule-engine-test-"));
}

/** Writes a JSON rules config to a temp file and returns its path. */
function writeRulesConfig(dir: string, config: RulesConfig): string {
  const filePath = path.join(dir, "rules.json");
  fs.writeFileSync(filePath, JSON.stringify(config), "utf8");
  return filePath;
}

/** Builds a minimal ThreadSummary for testing. */
function makeThread(threadId: string, senderEmail: string, lastDate: Date = new Date()): ThreadSummary {
  return {
    threadId,
    senderEmail,
    subject: "Test Subject",
    participants: [senderEmail],
    dateRange: { first: new Date("2020-01-01T00:00:00Z"), last: lastDate },
    content: "Test content",
    messageCount: 1,
  };
}

/** Builds a minimal SenderStats for testing. */
function makeSenderStats(senderEmail: string): SenderStats {
  return {
    senderEmail,
    senderName: senderEmail.split("@")[0] ?? "",
    emailCount: 10,
    firstEmailDate: "2025-01-01T00:00:00Z",
    lastEmailDate: "2026-01-01T00:00:00Z",
    gmailCategory: "primary",
    unreadRatio: 0.1,
    threadCount: 5,
    sampleSubjects: ["Subject 1"],
    surprisesFlag: false,
  };
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadRules
// ---------------------------------------------------------------------------

describe("loadRules()", () => {
  it("loads and validates a well-formed JSON config file", () => {
    const config: RulesConfig = {
      domainRules: { "chase.com": "financial", "irs.gov": "tax" },
      senderRules: { "landlord@example.com": "rental" },
    };
    const filePath = writeRulesConfig(tempDir, config);

    const result = loadRules(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.domainRules["chase.com"]).toBe("financial");
    expect(result.value.domainRules["irs.gov"]).toBe("tax");
    expect(result.value.senderRules["landlord@example.com"]).toBe("rental");
  });

  it("loads rules from a configPath argument (not hardcoded path)", () => {
    // Write config to a non-default path
    const subDir = path.join(tempDir, "custom-path");
    fs.mkdirSync(subDir);
    const config: RulesConfig = {
      domainRules: { "example.org": "testing" },
      senderRules: {},
    };
    const filePath = path.join(subDir, "my-custom-rules.json");
    fs.writeFileSync(filePath, JSON.stringify(config), "utf8");

    const result = loadRules(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.domainRules["example.org"]).toBe("testing");
  });

  it("returns ok:false when file does not exist", () => {
    const filePath = path.join(tempDir, "nonexistent.json");

    const result = loadRules(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not ok");
    expect(result.error).toMatch(/[Nn]ot found|ENOENT|does not exist/i);
  });

  it("returns ok:false when file contains invalid JSON", () => {
    const filePath = path.join(tempDir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json }", "utf8");

    const result = loadRules(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not ok");
    expect(result.error).toBeTruthy();
  });

  it("returns ok:false when JSON does not match RulesConfigSchema", () => {
    const filePath = path.join(tempDir, "wrong-schema.json");
    // Missing domainRules and senderRules fields
    fs.writeFileSync(filePath, JSON.stringify({ wrongField: "hello" }), "utf8");

    const result = loadRules(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not ok");
  });

  it("loads empty rules config with empty objects", () => {
    const config: RulesConfig = { domainRules: {}, senderRules: {} };
    const filePath = writeRulesConfig(tempDir, config);

    const result = loadRules(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(Object.keys(result.value.domainRules)).toHaveLength(0);
    expect(Object.keys(result.value.senderRules)).toHaveLength(0);
  });

  it("accepts nullable values (null categories) in rules", () => {
    const config = {
      domainRules: { "unknown.com": null },
      senderRules: { "someone@example.com": null },
    };
    const filePath = path.join(tempDir, "nullable.json");
    fs.writeFileSync(filePath, JSON.stringify(config), "utf8");

    const result = loadRules(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.domainRules["unknown.com"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classify — domain rules
// ---------------------------------------------------------------------------

describe("classify() — domain rules", () => {
  it("classifies chase.com sender as financial via domain rule", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    const thread = makeThread("t1", "alerts@chase.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("financial");
    expect(result!.classifiedBy).toBe("rule");
    expect(result!.ruleName).toBe("domain:chase.com");
    expect(result!.threadId).toBe("t1");
  });

  it("classifies irs.gov sender as tax via domain rule", () => {
    const rules: RulesConfig = {
      domainRules: { "irs.gov": "tax" },
      senderRules: {},
    };
    const thread = makeThread("t2", "no-reply@irs.gov");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("tax");
    expect(result!.classifiedBy).toBe("rule");
    expect(result!.ruleName).toBe("domain:irs.gov");
  });

  it("returns null for unmatched domain", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    const thread = makeThread("t3", "alice@example.com");

    const result = classify(thread, rules);

    expect(result).toBeNull();
  });

  it("domain matching is case-insensitive", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    // Upper-cased domain in sender email
    const thread = makeThread("t4", "alerts@CHASE.COM");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("financial");
  });
});

// ---------------------------------------------------------------------------
// classify — sender rules
// ---------------------------------------------------------------------------

describe("classify() — sender rules", () => {
  it("classifies exact sender landlord@example.com as rental", () => {
    const rules: RulesConfig = {
      domainRules: {},
      senderRules: { "landlord@example.com": "rental" },
    };
    const thread = makeThread("t5", "landlord@example.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("rental");
    expect(result!.classifiedBy).toBe("rule");
    expect(result!.ruleName).toBe("sender:landlord@example.com");
    expect(result!.threadId).toBe("t5");
  });

  it("sender matching is case-insensitive", () => {
    const rules: RulesConfig = {
      domainRules: {},
      senderRules: { "landlord@example.com": "rental" },
    };
    const thread = makeThread("t6", "LANDLORD@EXAMPLE.COM");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("rental");
  });

  it("returns null for unmatched sender", () => {
    const rules: RulesConfig = {
      domainRules: {},
      senderRules: { "landlord@example.com": "rental" },
    };
    const thread = makeThread("t7", "stranger@example.com");

    const result = classify(thread, rules);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classify — rule priority
// ---------------------------------------------------------------------------

describe("classify() — rule priority", () => {
  it("exact sender match beats domain match when both apply", () => {
    const rules: RulesConfig = {
      // Domain match would say "financial"
      domainRules: { "chase.com": "financial" },
      // Exact sender match says "vip"
      senderRules: { "vip@chase.com": "vip" },
    };
    const thread = makeThread("t8", "vip@chase.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    // Sender rule wins
    expect(result!.category).toBe("vip");
    expect(result!.ruleName).toBe("sender:vip@chase.com");
  });

  it("falls back to domain rule when no exact sender match", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: { "vip@chase.com": "vip" },
    };
    const thread = makeThread("t9", "alerts@chase.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("financial");
    expect(result!.ruleName).toBe("domain:chase.com");
  });
});

// ---------------------------------------------------------------------------
// classify — null category rules
// ---------------------------------------------------------------------------

describe("classify() — null category rules treated as unmatched", () => {
  it("null domain rule category returns null (passes to LLM)", () => {
    const rules: RulesConfig = {
      domainRules: { "unknown.com": null },
      senderRules: {},
    };
    const thread = makeThread("t10", "info@unknown.com");

    const result = classify(thread, rules);

    expect(result).toBeNull();
  });

  it("null sender rule category returns null (passes to LLM)", () => {
    const rules: RulesConfig = {
      domainRules: {},
      senderRules: { "contact@pending.com": null },
    };
    const thread = makeThread("t11", "contact@pending.com");

    const result = classify(thread, rules);

    expect(result).toBeNull();
  });

  it("null sender rule takes precedence over non-null domain rule — returns null", () => {
    const rules: RulesConfig = {
      // Domain would classify, but sender null overrides
      domainRules: { "example.com": "generic" },
      senderRules: { "specific@example.com": null },
    };
    const thread = makeThread("t12", "specific@example.com");

    const result = classify(thread, rules);

    // Sender rule wins priority, but its category is null → unmatched
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classify — output shape
// ---------------------------------------------------------------------------

describe("classify() — output shape", () => {
  it("sets confidence to 1.0 for rule matches", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    const thread = makeThread("t13", "alerts@chase.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
  });

  it("sets actionable to true when thread's last message is within 12 months", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    // Recent last date
    const recentDate = new Date();
    recentDate.setMonth(recentDate.getMonth() - 6); // 6 months ago
    const thread = makeThread("t14", "alerts@chase.com", recentDate);

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.actionable).toBe(true);
  });

  it("sets actionable to false when thread's last message is older than 12 months", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    // Old last date (2 years ago)
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 2);
    const thread = makeThread("t15", "alerts@chase.com", oldDate);

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.actionable).toBe(false);
  });

  it("summary is an empty string for rule matches", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: {},
    };
    const thread = makeThread("t16", "alerts@chase.com");

    const result = classify(thread, rules);

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("");
  });

  it("classifiedBy is 'rule' for all rule engine matches", () => {
    const rules: RulesConfig = {
      domainRules: { "chase.com": "financial" },
      senderRules: { "landlord@example.com": "rental" },
    };

    const domainResult = classify(makeThread("t17", "alerts@chase.com"), rules);
    const senderResult = classify(makeThread("t18", "landlord@example.com"), rules);

    expect(domainResult!.classifiedBy).toBe("rule");
    expect(senderResult!.classifiedBy).toBe("rule");
  });
});

// ---------------------------------------------------------------------------
// classify — empty rules
// ---------------------------------------------------------------------------

describe("classify() — empty rules config", () => {
  it("returns null for every sender when rules config is empty", () => {
    const rules: RulesConfig = { domainRules: {}, senderRules: {} };

    expect(classify(makeThread("t19", "alerts@chase.com"), rules)).toBeNull();
    expect(classify(makeThread("t20", "no-reply@irs.gov"), rules)).toBeNull();
    expect(classify(makeThread("t21", "landlord@example.com"), rules)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildRulesTemplateFromAudit
// ---------------------------------------------------------------------------

describe("buildRulesTemplateFromAudit()", () => {
  it("generates domain candidates from senderEmail domains with null categories", () => {
    const stats: SenderStats[] = [
      makeSenderStats("alice@chase.com"),
      makeSenderStats("bob@irs.gov"),
      makeSenderStats("carol@chase.com"), // duplicate domain
    ];

    const template = buildRulesTemplateFromAudit(stats);

    // Unique domains extracted
    expect(Object.keys(template.domainRules)).toContain("chase.com");
    expect(Object.keys(template.domainRules)).toContain("irs.gov");
    // Categories default to null
    expect(template.domainRules["chase.com"]).toBeNull();
    expect(template.domainRules["irs.gov"]).toBeNull();
  });

  it("deduplicates domain candidates", () => {
    const stats: SenderStats[] = [
      makeSenderStats("alice@chase.com"),
      makeSenderStats("bob@chase.com"),
      makeSenderStats("carol@chase.com"),
    ];

    const template = buildRulesTemplateFromAudit(stats);

    // Should only appear once
    const domains = Object.keys(template.domainRules);
    const chaseCount = domains.filter((d) => d === "chase.com").length;
    expect(chaseCount).toBe(1);
  });

  it("generates sender candidates as keys with null categories", () => {
    const stats: SenderStats[] = [makeSenderStats("landlord@example.com"), makeSenderStats("accountant@bigfirm.com")];

    const template = buildRulesTemplateFromAudit(stats);

    // Top senders included as sender candidates
    expect(Object.keys(template.senderRules)).toContain("landlord@example.com");
    expect(Object.keys(template.senderRules)).toContain("accountant@bigfirm.com");
    // Categories default to null
    expect(template.senderRules["landlord@example.com"]).toBeNull();
    expect(template.senderRules["accountant@bigfirm.com"]).toBeNull();
  });

  it("returns empty template for empty stats array", () => {
    const template = buildRulesTemplateFromAudit([]);

    expect(Object.keys(template.domainRules)).toHaveLength(0);
    expect(Object.keys(template.senderRules)).toHaveLength(0);
  });

  it("handles malformed email addresses gracefully (no @ sign)", () => {
    const stats: SenderStats[] = [{ ...makeSenderStats("noemail"), senderEmail: "noemail" }];

    // Should not throw
    expect(() => buildRulesTemplateFromAudit(stats)).not.toThrow();
  });

  it("skips empty or blank sender emails", () => {
    const stats: SenderStats[] = [
      { ...makeSenderStats("valid@example.com"), senderEmail: "valid@example.com" },
      { ...makeSenderStats(""), senderEmail: "" },
      { ...makeSenderStats("  "), senderEmail: "  " },
    ];

    const template = buildRulesTemplateFromAudit(stats);

    expect(Object.keys(template.senderRules)).toContain("valid@example.com");
    // Blank emails should be filtered out
    expect(Object.keys(template.senderRules)).not.toContain("");
    expect(Object.keys(template.senderRules)).not.toContain("  ");
  });
});
