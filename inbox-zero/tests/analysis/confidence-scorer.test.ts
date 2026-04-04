import { describe, expect, it } from "vitest";
import { scoreAll, scoreConfidence } from "../../src/analysis/confidence-scorer.ts";
import type { SenderStats } from "../../src/schemas/sender-stats.ts";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Base sender stats used as a starting point for test cases.
 * Most fields are set to neutral / "definitely_keep" territory so individual
 * test cases can override the fields they care about without noisy noise.
 */
function makeSender(overrides: Partial<SenderStats>): SenderStats {
  const base: SenderStats = {
    senderEmail: "contact@example.com",
    senderName: "Example Contact",
    emailCount: 10,
    firstEmailDate: "2024-01-01",
    lastEmailDate: new Date().toISOString().split("T")[0]!, // today — recent
    gmailCategory: "primary",
    unreadRatio: 0.1,
    threadCount: 8,
    sampleSubjects: ["Hello", "Follow-up"],
    surprisesFlag: false,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// scoreConfidence — hard overrides
// ---------------------------------------------------------------------------

describe("scoreConfidence — hard overrides", () => {
  it("noreply@ sender → definitely_noise + unsubscribe", () => {
    const stats = makeSender({ senderEmail: "noreply@newsletter.com" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("no-reply@ sender → definitely_noise + unsubscribe", () => {
    const stats = makeSender({ senderEmail: "no-reply@service.io" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("notifications@ sender → definitely_noise + unsubscribe", () => {
    const stats = makeSender({ senderEmail: "notifications@updates.example.com" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("noreply@ detection is case-insensitive (NOREPLY@)", () => {
    const stats = makeSender({ senderEmail: "NOREPLY@EXAMPLE.COM" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("no-reply@ detection is case-insensitive (No-Reply@)", () => {
    const stats = makeSender({ senderEmail: "No-Reply@Service.COM" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("notifications@ detection is case-insensitive (Notifications@)", () => {
    const stats = makeSender({ senderEmail: "Notifications@updates.com" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("known marketing domain mailchimp.com → definitely_noise + unsubscribe", () => {
    const stats = makeSender({
      senderEmail: "newsletter@mailchimp.com",
      gmailCategory: "primary",
      unreadRatio: 0.1,
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("known marketing domain sendgrid.net → definitely_noise + unsubscribe", () => {
    const stats = makeSender({ senderEmail: "bounce@sendgrid.net" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("known marketing domain constantcontact.com → definitely_noise + unsubscribe", () => {
    const stats = makeSender({ senderEmail: "info@constantcontact.com" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("subdomains of known marketing domain are also caught (r.mailchimp.com)", () => {
    const stats = makeSender({ senderEmail: "bounce@r.mailchimp.com" });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — classic noise scenario (weighted scoring path)
// ---------------------------------------------------------------------------

describe("scoreConfidence — weighted scoring: noise tiers", () => {
  it("noreply@ + Promotions + 100% unread → definitely_noise + unsubscribe", () => {
    // This sender would be caught by the hard noreply@ override, but demonstrates
    // that all signals point to the same outcome.
    const stats = makeSender({
      senderEmail: "noreply@promo.com",
      gmailCategory: "promotions",
      unreadRatio: 1.0,
      threadCount: 50,
      emailCount: 50,
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("high unread ratio + Social category + low thread count → probably_noise + filter", () => {
    // Score calculation (5-weight): unread(0.6)×0.30 + social(0.8)×0.20 + recent(0.0)×0.15 + threads(0.8)×0.10 + unknown(0.5)×0.25
    //   = 0.18 + 0.16 + 0.00 + 0.08 + 0.125 = 0.545 → in [0.5, 0.7) → probably_noise
    const todayMinus30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
    const stats = makeSender({
      senderEmail: "updates@social-app.com",
      gmailCategory: "social",
      unreadRatio: 0.6,
      threadCount: 3,
      emailCount: 30,
      lastEmailDate: todayMinus30, // recent — recency signal = 0.0
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("probably_noise");
    expect(result.recommendedAction).toBe("filter");
  });

  it("promotions category + high unread + old emails → definitely_noise + unsubscribe", () => {
    // Score calculation (5-weight): unread(0.9)×0.30 + promo(1.0)×0.20 + old(0.9)×0.15 + threads(0.3)×0.10 + unknown(0.5)×0.25
    //   = 0.27 + 0.20 + 0.135 + 0.03 + 0.125 = 0.76 → ≥ 0.7 → definitely_noise
    const stats = makeSender({
      senderEmail: "deals@retailer.com",
      gmailCategory: "promotions",
      unreadRatio: 0.9,
      threadCount: 5,
      emailCount: 40,
      lastEmailDate: "2023-01-01", // very old
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — keep tiers (weighted scoring path)
// ---------------------------------------------------------------------------

describe("scoreConfidence — weighted scoring: keep tiers", () => {
  it("Primary category + moderate unread + moderate recency → probably_keep + keep", () => {
    // Score calculation (5-weight): unread(0.3)×0.30 + primary(0.0)×0.20 + moderate-recency(0.4)×0.15 + threads(0.8)×0.10 + unknown(0.5)×0.25
    //   = 0.09 + 0.00 + 0.06 + 0.08 + 0.125 = 0.355 → in [0.3, 0.5) → probably_keep
    // "moderate recency" = 200 days ago (between 90 and 365 days)
    const todayMinus200 = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
    const stats = makeSender({
      senderEmail: "boss@company.com",
      gmailCategory: "primary",
      unreadRatio: 0.3,
      threadCount: 3,
      emailCount: 8,
      lastEmailDate: todayMinus200,
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("probably_keep");
    expect(result.recommendedAction).toBe("keep");
  });

  it("low unread + recent activity + multi-thread history → definitely_keep + keep", () => {
    // Score calculation (5-weight): unread(0.05)×0.30 + primary(0.0)×0.20 + recent(0.0)×0.15 + threads(0.0)×0.10 + unknown(0.5)×0.25
    //   = 0.015 + 0.00 + 0.00 + 0.00 + 0.125 = 0.14 → < 0.3 → definitely_keep
    const todayMinus7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
    const stats = makeSender({
      senderEmail: "colleague@work.com",
      gmailCategory: "primary",
      unreadRatio: 0.05,
      threadCount: 20,
      emailCount: 25,
      lastEmailDate: todayMinus7,
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("definitely_keep");
    expect(result.recommendedAction).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — edge cases
// ---------------------------------------------------------------------------

describe("scoreConfidence — edge cases", () => {
  it("sender with emailCount=1 → probably_keep (not enough signal — conservative default)", () => {
    const stats = makeSender({
      senderEmail: "unknown@stranger.com",
      gmailCategory: "promotions",
      unreadRatio: 1.0,
      threadCount: 1,
      emailCount: 1,
    });
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBe("probably_keep");
    expect(result.recommendedAction).toBe("keep");
  });

  it("emailCount=1 still applies conservative default even with hard-override email name", () => {
    // noreply@ hard override takes precedence — even over the emailCount=1 rule
    const stats = makeSender({
      senderEmail: "noreply@single.com",
      emailCount: 1,
    });
    const result = scoreConfidence(stats);
    // Hard override wins — noreply@ → definitely_noise regardless of count
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — surprise detection
// ---------------------------------------------------------------------------

describe("scoreConfidence — surprise detection", () => {
  it("Primary category + unreadRatio > 0.8 + emailCount > 20 → surprisesFlag = true", () => {
    const stats = makeSender({
      senderEmail: "newsletter@company.com",
      gmailCategory: "primary",
      unreadRatio: 0.9,
      threadCount: 8,
      emailCount: 25,
    });
    const result = scoreConfidence(stats);
    expect(result.surprisesFlag).toBe(true);
  });

  it("Primary + unreadRatio exactly 0.8 → surprisesFlag = false (boundary — not > 0.8)", () => {
    const stats = makeSender({
      senderEmail: "newsletter@company.com",
      gmailCategory: "primary",
      unreadRatio: 0.8,
      emailCount: 25,
    });
    const result = scoreConfidence(stats);
    expect(result.surprisesFlag).toBe(false);
  });

  it("Primary + unreadRatio > 0.8 + emailCount exactly 20 → surprisesFlag = false (boundary — not > 20)", () => {
    const stats = makeSender({
      senderEmail: "newsletter@company.com",
      gmailCategory: "primary",
      unreadRatio: 0.9,
      emailCount: 20,
    });
    const result = scoreConfidence(stats);
    expect(result.surprisesFlag).toBe(false);
  });

  it("Promotions + high unread + high emailCount → surprisesFlag = false (not Primary)", () => {
    const stats = makeSender({
      senderEmail: "deals@promo.com",
      gmailCategory: "promotions",
      unreadRatio: 0.95,
      emailCount: 50,
    });
    const result = scoreConfidence(stats);
    expect(result.surprisesFlag).toBe(false);
  });

  it("normal primary sender with low unread → surprisesFlag = false", () => {
    const stats = makeSender({
      senderEmail: "friend@gmail.com",
      gmailCategory: "primary",
      unreadRatio: 0.1,
      emailCount: 30,
    });
    const result = scoreConfidence(stats);
    expect(result.surprisesFlag).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — return type immutability (does not mutate input)
// ---------------------------------------------------------------------------

describe("scoreConfidence — pure function / immutability", () => {
  it("does not mutate the input object", () => {
    const stats = makeSender({ senderEmail: "contact@example.com" });
    const inputTierBefore = stats.confidenceTier;
    scoreConfidence(stats);
    expect(stats.confidenceTier).toBe(inputTierBefore);
  });

  it("always returns a new object with confidenceTier and recommendedAction set", () => {
    const stats = makeSender({});
    const result = scoreConfidence(stats);
    expect(result.confidenceTier).toBeDefined();
    expect(result.recommendedAction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// scoreAll — batch convenience wrapper
// ---------------------------------------------------------------------------

describe("scoreAll", () => {
  it("scores all senders in an array and returns an array of same length", () => {
    const senders = [makeSender({ senderEmail: "noreply@a.com" }), makeSender({ senderEmail: "colleague@work.com" })];
    const results = scoreAll(senders);
    expect(results).toHaveLength(2);
  });

  it("each element in the result has confidenceTier and recommendedAction", () => {
    const senders = [makeSender({ senderEmail: "a@example.com" }), makeSender({ senderEmail: "b@example.com" })];
    const results = scoreAll(senders);
    for (const r of results) {
      expect(r.confidenceTier).toBeDefined();
      expect(r.recommendedAction).toBeDefined();
    }
  });

  it("returns an empty array for empty input", () => {
    const results = scoreAll([]);
    expect(results).toHaveLength(0);
  });

  it("applies hard override for noreply@ inside scoreAll", () => {
    const senders = [makeSender({ senderEmail: "noreply@newsletter.com" })];
    const results = scoreAll(senders);
    expect(results[0]!.confidenceTier).toBe("definitely_noise");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — senderType signal (5th scoring signal)
// ---------------------------------------------------------------------------

describe("scoreConfidence — senderType signal", () => {
  it("human senderType boosts toward keep", () => {
    // Score: unread(0.5)×0.30 + primary(0.0)×0.20 + recent(0.0)×0.15 + threads(0.3)×0.10 + human(0.0)×0.25
    //   = 0.15 + 0.00 + 0.00 + 0.03 + 0.00 = 0.18 → < 0.3 → definitely_keep
    const base = makeSender({ senderType: "human", unreadRatio: 0.5, gmailCategory: "primary" });
    const result = scoreConfidence(base);
    expect(result.confidenceTier).toBe("definitely_keep");
  });

  it("newsletter senderType pushes toward noise", () => {
    // Score: unread(0.5)×0.30 + updates(0.6)×0.20 + recent(0.0)×0.15 + threads(0.3)×0.10 + newsletter(0.8)×0.25
    //   = 0.15 + 0.12 + 0.00 + 0.03 + 0.20 = 0.50 → ≥ 0.5 → probably_noise
    const base = makeSender({ senderType: "newsletter", unreadRatio: 0.5, gmailCategory: "updates" });
    const result = scoreConfidence(base);
    expect(["probably_noise", "definitely_noise"]).toContain(result.confidenceTier);
  });

  it("automated senderType is strongest noise signal", () => {
    // Score: unread(0.7)×0.30 + primary(0.0)×0.20 + recent(0.0)×0.15 + threads(0.8)×0.10 + automated(0.9)×0.25
    //   = 0.21 + 0.00 + 0.00 + 0.08 + 0.225 = 0.515 → ≥ 0.5 → probably_noise
    // Without automated (unknown=0.5): 0.21 + 0.00 + 0.00 + 0.08 + 0.125 = 0.415 → probably_keep
    // Demonstrates that automated type alone pushes across the noise boundary.
    const base = makeSender({ senderType: "automated", unreadRatio: 0.7, gmailCategory: "primary", threadCount: 2 });
    const result = scoreConfidence(base);
    expect(["probably_noise", "definitely_noise"]).toContain(result.confidenceTier);
  });

  it("unknown senderType is neutral (0.5)", () => {
    const withUnknown = makeSender({ senderType: "unknown", unreadRatio: 0.5 });
    const without = makeSender({ unreadRatio: 0.5 });
    // unknown should behave identically to no senderType (both map to noise=0.5)
    const r1 = scoreConfidence(withUnknown);
    const r2 = scoreConfidence(without);
    expect(r1.confidenceTier).toBe(r2.confidenceTier);
  });
});

// ---------------------------------------------------------------------------
// scoreConfidence — weight rebalancing regression
// ---------------------------------------------------------------------------

describe("scoreConfidence — weight rebalancing", () => {
  it("hard overrides still work unchanged", () => {
    const noreply = makeSender({ senderEmail: "noreply@company.com" });
    const result = scoreConfidence(noreply);
    expect(result.confidenceTier).toBe("definitely_noise");
    expect(result.recommendedAction).toBe("unsubscribe");
  });

  it("emailCount <= 1 still returns probably_keep", () => {
    const single = makeSender({ emailCount: 1 });
    const result = scoreConfidence(single);
    expect(result.confidenceTier).toBe("probably_keep");
  });
});
