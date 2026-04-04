# Sender Enrichment & Conversational Review — Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Depends on:** `2026-03-17-gmail-inbox-zero-design.md` (Phase 1 spec)

## Problem

The confidence scorer classifies 583k emails across 22k senders into four tiers. But 16k senders (73%) land in "probably_keep" because the scorer has only four signals (unread ratio, Gmail category, recency, thread count). It cannot distinguish a human colleague from a company newsletter that Gmail categorized as Primary.

Presenting 22k rows in a spreadsheet and asking the user to manually decide each one is unusable. The user needs an intelligent assistant that pre-classifies senders, presents actionable batches, learns from decisions, and executes approved actions — a chief-of-staff workflow, not a spreadsheet audit.

## Design Overview

Add a **sender enrichment pipeline** and a **conversational review loop** on top of the existing analysis toolchain. The enrichment adds a `senderType` classification. The review loop presents batched recommendations in conversation, executes approved actions, and feeds decisions back to improve future classification.

### Data Flow

```
SETUP (once, or re-run for incremental refinement):
  loadAllBatches() → analyzeSenders()* → merge sender-state → enrichSenders() → scoreAll()
                  → persist data/sender-state.v1.json → write audit sheet

  * analyzeSenders() now also aggregates starredCount/importantCount for extraction scoring

REVIEW LOOP (per batch, driven by Claude Code in conversation):
  1. Read sender-state + decision log + any active batch manifests from disk
  2. Build next batch (25-50 senders, grouped by type)
  3. Present numbered list to user in conversation
  4. User approves / calls out exceptions / optionally corrects sender type
  5. Persist a frozen batch manifest → data/review-runs/<runId>/batch-0001.json
     and render a companion batch brief → data/review-runs/<runId>/batch-0001-brief.md
  6. execute-batch: resume that manifest, apply Gmail actions, append decision log,
     update sender-state, then update the audit sheet
  7. Mark the manifest complete
  8. (Background) Re-run LLM on remaining unknown/low-confidence senders in sender-state
     that are not already frozen into an active batch

RE-SCORING (incremental, not full pipeline):
  Only re-runs LLM classification (Phase 2) on sender-state entries that are still unknown
  or < 0.7 confidence and are not already locked into an active batch manifest.
  Does NOT re-run heuristics or analyzeSenders(). Only senderType-related fields are updated
  in sender-state; action history and reviewed batches are never rewritten by re-scoring.
```

### Canonical Local State

This design needs a durable local system of record. The Google Sheet is a projection for audit/review, not the canonical state.

**New artifact:** `data/sender-state.v1.json`

```typescript
const SenderStateFileSchema = z.object({
  version: z.literal(1),
  mailbox: z.string(),
  generatedAt: z.string().datetime(),
  senders: z.array(SenderStatsSchema.extend({
    senderType: SenderTypeEnum.optional(),
    senderTypeConfidence: z.number().min(0).max(1).optional(),
    senderTypeSource: z.enum(["heuristic", "llm", "user"]).optional(),
    reviewedSenderType: SenderTypeEnum.optional(),
    reviewedAt: z.string().datetime().optional(),
    processedAt: z.string().datetime().optional(),
  })),
});
```

**Ownership model:**
- `analyzeSenders()` always rebuilds deterministic aggregates (`emailCount`, dates, unread ratio, thread count, sample subjects, starredCount, importantCount) from raw metadata batches.
- The persisted sender-state file owns enrichment and review fields (`senderType`, confidence, user corrections, processedAt).
- Re-runs merge by `senderEmail`. If a sender still exists in the current metadata pull, deterministic fields are refreshed and enrichment/review fields are carried forward. If a sender disappears from the current pull, it disappears from the regenerated sender-state file and remains only in the decision log history.

**Write discipline:** all local JSON artifacts in this design (`sender-state`, decision log, run manifests) must be written via `tmp` + atomic rename. A partially-written file must never become the canonical state.
Markdown briefing files may be regenerated and are never the source of truth.

## Sender Enrichment Pipeline

### New Field: `senderType`

Added to `SenderStatsSchema` as optional fields (absent until enrichment runs, backward-compatible):

```typescript
// New Zod enum + fields in sender-stats.ts
const SenderTypeEnum = z.enum(["human", "company", "newsletter", "automated", "unknown"]);
type SenderType = z.infer<typeof SenderTypeEnum>;

// Added to SenderStatsSchema:
senderType: SenderTypeEnum.optional(),       // populated by enrichment pipeline
senderTypeConfidence: z.number().min(0).max(1).optional(),  // LLM confidence or heuristic score
extractionCandidate: z.boolean().optional(),  // populated by enrichment pipeline
```

Populated by a two-phase enrichment pipeline that runs between `analyzeSenders()` and `scoreAll()`.

### Phase 1: Heuristic Classifier (deterministic, free, instant)

Applied to all 22k senders. Each heuristic emits a vote with a confidence weight. If combined confidence exceeds a threshold, the sender is classified. Otherwise it goes to Phase 2.

**Heuristic signals:**

1. **Freemail domain detection** — gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com, aol.com, protonmail.com, and ~15 more → strong `human` signal (weight: 0.7)

2. **Automated local-part detection** — noreply, no-reply, notifications, support, billing, info, team, hello, mailer, digest, updates, news, marketing → strong `automated` signal (weight: 0.8)

3. **Display name pattern analysis:**
   - "Firstname Lastname" (2-3 capitalized words, no special chars) → `human` (weight: 0.4)
   - Contains "Team", "Inc", "LLC", "Corp", "Newsletter", "Updates", "Digest", "News" → `company`/`newsletter` (weight: 0.5)
   - Single word that matches common first names → weak `human` (weight: 0.2)
   - Empty or matches email local part → `automated` (weight: 0.3)

4. **Thread ratio** — `threadCount / emailCount`:
   - Ratio ≥ 0.7 (most emails are unique threads / conversations) → `human` signal (weight: 0.3)
   - Ratio ≤ 0.1 (many emails, few threads — bulk sends) → `newsletter`/`automated` signal (weight: 0.4)

5. **Subject pattern detection** — regex matching against `sampleSubjects`:
   - Recurring templates: "Your * receipt", "Order #*", "Shipping update", "Weekly digest", "Monthly report" → `automated` (weight: 0.5)
   - Conversational patterns: "Re: *", varied subjects with no template → `human` (weight: 0.3)

**Aggregation algorithm:**

Each heuristic emits a `(type, weight)` vote. Votes are accumulated per sender type:

```
scores = { human: 0, company: 0, newsletter: 0, automated: 0 }
For each heuristic that fires:
  scores[voted_type] += weight
```

**Conflict resolution:** When signals contradict (e.g., `noreply@gmail.com` — freemail domain votes `human:0.7`, automated local-part votes `automated:0.8`), both votes accumulate independently. The highest-scoring type wins.

**Precedence:** Automated local-part detection runs first and is treated as a hard override — if the local part matches (noreply, no-reply, notifications, mailer, digest), the sender is classified as `automated` regardless of domain. This prevents `noreply@gmail.com` from being classified as `human`.

**Classification threshold:** After all heuristics run, if `max(scores) ≥ 0.6`, assign the highest-scoring type. If two types tie at ≥ 0.6, prefer the non-human type (safer — cautious approach). If no type reaches 0.6 → Phase 2 (LLM).

**Worked example — `jane.smith@acme.com` (display name "Jane Smith", 45 emails, 38 threads, subjects: "Re: Q4 planning", "Meeting notes", "Quick question"):**
- Freemail domain: no match → no vote
- Automated local-part: no match → no vote
- Display name "Jane Smith" (2 capitalized words): `human:0.4`
- Thread ratio 38/45 = 0.84 ≥ 0.7: `human:0.3`
- Subject patterns: "Re: *" + varied subjects: `human:0.3`
- Final scores: `human:1.0`, all others: 0
- Result: `human` (1.0 ≥ 0.6)

**Worked example — `noreply@gmail.com` (display name "Google", 200 emails, 5 threads):**
- Automated local-part "noreply": **hard override** → `automated`
- (Freemail domain vote is skipped due to hard override)

### Phase 2: LLM Classification (ambiguous senders only)

Batch ambiguous senders and send to Claude for classification. Input per sender:
- Sender email address
- Display name
- Email domain
- Sample subjects (up to 5)
- Email count
- Gmail category
- Unread ratio
- Thread count

**Batching:** ~50 senders per API call. Expected ~3-5k ambiguous senders → ~60-100 API calls. Uses the existing `AnthropicProvider` interface from `llm-classifier.ts`, extended with a new `classifySenders()` method. Inherits existing retry/backoff logic.

**Model:** Claude Haiku for cost efficiency — sender classification is a simpler task than thread classification. Falls back to Sonnet on Haiku errors.

**No privacy restrictions** on input to the LLM. All sender metadata can be sent.

**Prompt structure:**

```
System: You classify email senders. For each sender, return a JSON object with
"senderType" (human|company|newsletter|automated) and "confidence" (0-1).

{few_shot_examples_from_decision_log}

User: Classify these senders:
[
  {"email": "...", "name": "...", "domain": "...", "subjects": [...],
   "emailCount": N, "gmailCategory": "...", "unreadRatio": N, "threadCount": N},
  ...
]
```

**Expected response format (structured JSON):**

```json
[
  {"email": "sender@example.com", "senderType": "newsletter", "confidence": 0.92},
  ...
]
```

**Error handling:** If the LLM response fails to parse as JSON or is missing fields, retry once. On second failure, mark the sender as `unknown` and move on. Malformed individual entries within a valid batch response are skipped (marked `unknown`) without failing the entire batch.

**Output:** `senderType` classification + confidence score (0-1) per sender.

**Hybrid timing strategy:**
1. **Upfront bulk pass** — classify all ambiguous senders before review begins. Pre-scores the entire sheet so the user can start reviewing immediately with no latency.
2. **Incremental refinement** — after each review batch, re-run LLM classification on remaining unreviewed senders that are still `unknown` or scored below 0.7 confidence. The few-shot context comes only from reviewed sender-type labels, not from keep/filter/unsubscribe actions. Re-scoring runs in background while the user reviews the current batch.
3. **No invalidation of presented batches** — if re-scoring changes a sender's type, it takes effect when that sender's batch is prepared for presentation. Already-presented-but-not-yet-reviewed batches are not reordered.

**Important separation:** `senderType` and `userDecision` are different targets.
- `senderType` answers "what kind of sender is this?"
- `userDecision` answers "what do I want to do with this sender?"

The model may learn sender type only from explicit type feedback stored in sender-state / decision log. It must not infer sender type from an action override. A user choosing `keep` for a newsletter does not make the sender `human`.

## Confidence Scorer Updates

The scorer gains `senderType` as a fifth signal:

**New weight allocation (must sum to 1.0):**
- Unread ratio: 0.30 (was 0.40)
- Gmail category: 0.20 (was 0.25)
- Recency: 0.15 (was 0.20)
- Thread count: 0.10 (was 0.15)
- **Sender type: 0.25 (new)**

**Sender type noise scores:**
- `human` → 0.0 (strong keep signal)
- `company` → 0.5 (neutral — depends on engagement)
- `newsletter` → 0.8 (strong noise signal)
- `automated` → 0.9 (very strong noise signal)
- `unknown` → 0.5 (neutral, same as current behavior)

**Expected impact:** Most of the 16k "probably_keep" senders classified as `newsletter` or `automated` will shift to "probably_noise" or "definitely_noise", collapsing the ambiguous middle.

## Extraction Candidate Flag

A boolean `extractionCandidate` flag on `SenderStats`, populated during enrichment. Identifies senders whose emails may have content worth extracting to Obsidian in Phase 2.

**Composite score based on email importance research (Google Priority Inbox, 2010):**

All signals use data currently available in `SenderStats` and `EmailMetadata`:

- **Reply/conversation behavior (~40%)** — proxy: `threadCount / emailCount` ratio. High ratio (≥ 0.5) suggests back-and-forth conversation, implying the user replied. This is a per-sender aggregate, not per-thread depth.
- **Read behavior (~30%)** — proxy: `1 - unreadRatio`. High read rate = user consistently engages. Directly available on `SenderStats`.
- **Explicit signals (~20%)** — requires a new per-sender aggregate: count of messages from this sender that have "STARRED" or "IMPORTANT" in their `labels` array (from `EmailMetadata`). Added during `analyzeSenders()` as `starredCount` and `importantCount` fields on `SenderStats`. The extraction score uses `(starredCount + importantCount) / emailCount` as the signal.
- **Content features (~10%)** — `senderType === "human"` (from enrichment) + `gmailCategory === "primary"` + `emailCount ≥ 3` (sustained relationship). All available on `SenderStats`.

**Schema additions to `SenderStatsSchema`:**
```typescript
starredCount: z.number().int().min(0).default(0),
importantCount: z.number().int().min(0).default(0),
```

**Threshold:** Composite score ≥ 0.5 → `extractionCandidate = true`.

**This flag is informational, not a gate.** It does not block any cleanup action. It adds a column to the audit sheet so the user can see which senders might have extractable value before deciding to archive.

## Conversational Review Loop

The primary review interface is **conversation, not the spreadsheet**. The spreadsheet is the audit trail.

### Review Flow

1. **Enrichment + scoring complete** → sheet populated with all columns
2. **Work type-by-type** — newsletters first, then automated, companies, humans
3. **Per batch (25-50 senders, sorted by email count descending within each type — highest-volume senders first for maximum impact):**
   a. Present a numbered list with key stats (sender name, email count, last email date, recommended action)
   b. Include a top-line summary: "These 35 newsletter senders account for 52k emails. Average unread rate: 94%. Recommendation: unsubscribe + archive all."
   c. User approves, or calls out exceptions by number: "yes, but keep 7 and 19" / "3 is human, keep it"
   d. Persist the exact batch membership + decisions + any type corrections to a batch manifest before any Gmail side effects
   e. Execute approved actions by resuming that manifest
   f. Update sender-state, decision log, and sheet "Processed" column only after the manifest records successful execution
   g. Trigger background re-score of remaining senders with new sender-type few-shot context
4. **Move to next batch / next type**

### Batch Presentation Format

```
## Newsletter senders — Batch 1 of 4 (35 senders, 52k emails)

94% average unread rate. Recommendation: unsubscribe where possible, filter + archive all.

 1. marketing@example.com    — Example Corp      — 2,340 emails — last: 2026-02-15
 2. news@techdigest.io       — Tech Digest        —   890 emails — last: 2026-03-10
 3. hello@saasproduct.com    — SaaS Product       —   456 emails — last: 2025-11-02
...
35. updates@oldservice.net   — Old Service         —    12 emails — last: 2024-06-30

Approve all? Or call out numbers to keep.
```

### Action Execution

Actions differ by sender type and user decision:

| Decision | Action |
|----------|--------|
| **unsubscribe** | Create Gmail filter (skip inbox, apply `_noise` label) → retroactively archive all messages from sender in Gmail (full mailbox search, not just metadata-matched) |
| **filter** | Create Gmail filter (skip inbox, apply `_noise` label) → retroactively archive all messages from sender in Gmail |
| **keep** | No action. Mark as reviewed in sheet. |

**Unsubscribe = filter + intent.** For this spec, "unsubscribe" and "filter" execute the same Gmail actions (create filter, archive). The distinction is recorded in the decision log so that a future automated unsubscribe pass can act on senders marked "unsubscribe" via `List-Unsubscribe` headers. Actual `List-Unsubscribe` execution (mailto vs. https variants, reliability, rate limiting) is deferred to a follow-up spec — it requires retrieving headers not currently in our metadata and has security/reliability implications that warrant separate design.

**Unsubscribe caution:** Only recommend "unsubscribe" when the user explicitly approves. For senders where the LLM or heuristics are uncertain, default recommendation is "filter" (reversible) not "unsubscribe" (irreversible). If the user hasn't seen a sender name and the system isn't confident, ask.

**Execution scope:** Operate on ALL messages in Gmail from the sender address (via API search `from:sender@example.com`), not limited to the 583k metadata set.

### Batch Manifest and Resume Semantics

`execute-batch` must be resumable and idempotent. A batch is not "whatever the next query would return"; it is a frozen manifest on disk.

**New artifact:** `data/review-runs/<runId>/batch-0001.json`

```typescript
const BatchManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  batchId: z.string(),
  status: z.enum(["prepared", "executing", "completed", "failed"]),
  createdAt: z.string().datetime(),
  senders: z.array(z.object({
    senderEmail: z.string(),
    presentedSenderType: SenderTypeEnum,
    reviewedSenderType: SenderTypeEnum.optional(),
    systemRecommendation: z.enum(["keep", "filter", "unsubscribe"]),
    userDecision: z.enum(["keep", "filter", "unsubscribe"]),
    filterStatus: z.enum(["pending", "done", "skipped"]),
    archiveStatus: z.enum(["pending", "done", "skipped"]),
    logStatus: z.enum(["pending", "done"]),
    stateStatus: z.enum(["pending", "done"]),
    sheetStatus: z.enum(["pending", "done"]),
  })),
});
```

**Execution contract:**
1. Persist the manifest with exact sender membership before any Gmail write.
2. Transition to `executing`.
3. Generate a companion Markdown brief for human/agent orientation.
4. Advance each sender step-by-step, updating the manifest after each successful step.
5. Refresh the brief when execution state materially changes.
6. Mark the batch `completed` only after Gmail side effects, decision-log append, sender-state merge, and sheet updates are all durable.

**Idempotency requirements:**
- Retroactive archive is naturally idempotent: re-applying `_noise` and removing `INBOX` is safe.
- Filter creation is **not** naturally idempotent in the current code path. The implementation must use an `ensureSenderFilter()`-style operation that checks for an existing equivalent filter before creating one.
- Re-scoring must ignore senders that are already present in any `prepared` or `executing` batch manifest. Frozen batches are never silently reshaped.

### Batch Brief

**Companion artifact:** `data/review-runs/<runId>/batch-0001-brief.md`

The batch brief exists to make later sessions faster for humans and agents. It is not parsed for correctness decisions and must always be derivable from the manifest plus sender-state.

**Purpose:**
- Fast handoff when a later session needs to understand why this batch exists
- Readable context for approval before execution
- Concise execution summary after completion

**Required contents:**
- Batch identifier, run identifier, and status
- Batch type/grouping rationale
- Headline counts: sender count, total email count, average unread ratio
- The presented recommendation for the batch
- Numbered sender list with any user-called exceptions or sender-type corrections
- Post-execution summary: filters ensured, messages archived, failures, unresolved follow-up

**Safety rule:** if the brief conflicts with the JSON manifest, the manifest wins. The brief may be regenerated at any time from canonical state.

## Decision Log

### JSON Decision Log — `data/decision-log.json`

Durable, machine-readable audit record of completed review decisions. Used as few-shot context for LLM re-scoring only when it contains explicit sender-type feedback. Defined by a `DecisionLogSchema` (Zod) in `src/schemas/decision-log.ts`.

```typescript
const DecisionEntrySchema = z.object({
  runId: z.string(),
  senderEmail: z.string(),
  senderName: z.string(),
  presentedSenderType: SenderTypeEnum,
  reviewedSenderType: SenderTypeEnum.optional(),
  senderTypeFeedback: z.enum(["none", "confirmed", "corrected"]),
  systemRecommendation: z.enum(["keep", "filter", "unsubscribe"]),
  userDecision: z.enum(["keep", "filter", "unsubscribe"]),
  batchId: z.string(),
  timestamp: z.string().datetime(),
  emailCount: z.number().int().min(0),
  actionsTaken: z.array(z.string()),
});

const DecisionLogSchema = z.object({
  version: z.literal(1),
  decisions: z.array(DecisionEntrySchema),
});
```

**Few-shot context extraction:** When building LLM prompts, select the most recent 50 entries where `senderTypeFeedback !== "none"`. Prioritize `corrected` over `confirmed`. Keep/filter/unsubscribe overrides without sender-type feedback are not valid training data for sender classification and must be ignored.

**Batch progress tracking:** The decision log is not the resume source. Batch completion is determined only from batch manifests under `data/review-runs/<runId>/`. This avoids ambiguity when a crash happens after some Gmail side effects but before the decision log append finishes.

### Sheet as UI

The audit spreadsheet remains the visual audit trail. After each batch execution:
- "Your decision" column populated with the user's choice
- "Processed" column marked with timestamp
- `Dashboard` tab updated with running totals

### Dashboard Sheet

Use a separate `Dashboard` tab instead of inserting summary rows into `Sheet1`. This preserves the current reader/writer contract for the audit sheet.

The dashboard tab contains a progress summary:

| Metric | Value |
|--------|-------|
| Total senders | 21,981 |
| Processed | 0 |
| Emails cleared | 0 |
| Unsubscribed | 0 |
| Filters created | 0 |
| Remaining | 21,981 |
| Current section | — |

Updated programmatically after each batch execution via Sheets API.

## Audit Sheet Updates

**Approach: append-only on `Sheet1`.** New columns are added at the end of the existing 13-column layout. This preserves backward compatibility with the existing `sheets-reporter.ts` header/row mapping and existing readers that expect row 1 to be the header row and data to begin at row 2.

### Column Order (16 total)

1. Sender email (existing)
2. Sender name (existing)
3. Email count (existing)
4. First email date (existing)
5. Last email date (existing)
6. Gmail category (existing)
7. Unread ratio (existing)
8. Thread count (existing)
9. Sample subjects (existing)
10. Confidence tier (existing)
11. Recommended action (existing)
12. Surprises flag (existing)
13. Your decision (existing)
14. **Sender type** (new — enrichment pipeline)
15. **Extraction candidate** (new — enrichment pipeline, "Yes"/"No")
16. **Processed** (new — review loop, timestamp when executed)

**Main audit sheet layout remains stable:** headers stay at `A1`, data starts at `A2`, and the decision column remains in the same relative location within `Sheet1`. Dashboard metrics live on the separate `Dashboard` tab.

## Cross-Session Continuity

### HANDOVER.md

Updated after each review session with:
- Sections completed (e.g., "Newsletters: 4/4 batches done, 892 senders processed")
- Sections remaining
- Total emails cleared so far
- Any senders deferred for user follow-up
- Link to decision log, audit sheet, and latest batch brief

### Sheet Dashboard

Visible as a dedicated spreadsheet tab for at-a-glance progress without opening a terminal.

## CLI Integration

### New Command: `enrich`

```bash
GOOGLE_SERVICE_ACCOUNT_KEY=.secrets/service-account.json npm run cli -- enrich
```

Runs the enrichment pipeline (heuristics + upfront LLM classification), updates `data/sender-state.v1.json`, and regenerates the audit sheet with the new columns. Idempotent — re-running merges new LLM results with existing classifications in sender-state (LLM results with higher confidence overwrite lower-confidence results; user-reviewed sender types are never overwritten by the LLM).

### Updated Command: `analyze`

The existing `analyze` command calls enrichment automatically before scoring. Running `analyze` rebuilds deterministic sender aggregates from raw metadata, merges preserved enrichment/review fields from `data/sender-state.v1.json`, writes the refreshed sender-state file, and then produces a fully enriched, scored sheet.

### New Command: `execute-batch`

```bash
GOOGLE_SERVICE_ACCOUNT_KEY=.secrets/service-account.json npm run cli -- execute-batch --manifest data/review-runs/<runId>/batch-0001.json --sheet-id <ID>
```

Reads a frozen batch manifest (not the sheet) and resumes it until completion. The data flow during conversational review:

1. User approves/rejects senders in conversation
2. Claude Code writes approved decisions and any type corrections to `data/review-runs/<runId>/batch-0001.json`
3. Claude Code renders `data/review-runs/<runId>/batch-0001-brief.md` for review/handoff
4. `execute-batch` reads that manifest, resumes any incomplete steps, and executes actions (ensure filter, archive)
5. After each successful step, it updates the manifest and refreshes the brief if needed
6. Once all senders are durable, it appends to `data/decision-log.json`, updates `data/sender-state.v1.json`, and updates the audit sheet (Processed column + Your decision column)

The sheet is updated AFTER execution as an audit trail, not read as input. The manifest is the execution source of truth; the sheet is only a projection.

**Conversational review is driven by Claude Code** (this CLI tool). The batch presentation, user interaction, and execution coordination happen within a Claude Code session. No separate interactive CLI prompt or web UI is needed.

### Relationship to Existing Hard Overrides

The confidence scorer's existing hard overrides (noreply addresses, marketing domains → `definitely_noise`) remain in the scorer. The heuristic classifier's local-part detection serves a different purpose — it classifies `senderType`, not confidence tier. Both can fire for the same sender without conflict: the heuristic sets `senderType: "automated"`, and the scorer's hard override sets `confidenceTier: "definitely_noise"`. They reinforce each other.

## Testing Strategy

- **Heuristic classifier:** Unit tests with known sender patterns (freemail domains, noreply addresses, display name patterns, subject templates). Test edge cases: company employee on gmail.com, human with "team" in name.
- **LLM classifier:** Integration tests with mocked API responses. Verify batching logic, few-shot context injection, and error handling for API failures.
- **Confidence scorer:** Existing tests updated with `senderType` signal. Verify weight rebalancing doesn't break existing tier assignments for clear-cut cases.
- **Execution pipeline:** Integration tests verifying resumable batch manifests, idempotent filter creation, archive operations, sender-state updates, and sheet updates. Mock Gmail API for tests.
- **Batch brief generation:** Snapshot tests verifying the brief is derivable from manifest + sender-state and clearly marks itself non-canonical.
- **Decision log + sender-state:** Unit tests for atomic write/read, merge-by-sender behavior, and few-shot context extraction.
- **Extraction candidate:** Unit tests verifying composite score calculation and threshold behavior.

## Out of Scope

- Email body analysis for enrichment (Phase 2 concern)
- Automated daily digest (separate spec, runs after inbox zero achieved)
- Bulk delete (only archive — messages remain recoverable)
- External enrichment APIs (Exa.ai, Clearbit) — heuristics + LLM is sufficient
