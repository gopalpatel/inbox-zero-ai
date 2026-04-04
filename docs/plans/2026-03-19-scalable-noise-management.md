# Plan: Scalable Noise Management — Sweep + Consolidated Filters

## Context

We've hit Gmail's hard 1,000 filter limit after processing just 1,189 newsletter senders (~950 filters consumed). With 20,632 senders still to review (automated: 4,770, companies: 4,007, humans: 11,855), per-sender filters fundamentally don't scale. Domain consolidation doesn't help — 2,206 unique domains for 80% automated coverage.

**The archive step already works** — `execute-batch` retroactively archives via `batchModifyMessages` with no filter limit. The gap is *preventing future noise from landing in inbox*. A periodic sweep achieves this without consuming filter slots.

**Decision:** Build full infrastructure (all tasks) before resuming sender reviews.

## Strategy: Archive + Sweep + Consolidated Filters

| Layer | Purpose | Filter slots | Latency |
|-------|---------|-------------|---------|
| **Archive** (existing) | Retroactive cleanup | 0 | Immediate |
| **Sweep** (new) | Catches new noise every 15 min | 0 | ≤15 min |
| **Consolidated filters** (new) | Real-time for top-volume senders | ~30–50 | Instant |

The sweep reads the decision log via `decisionLogPath` and `collectNoiseSenders()` and archives inbox messages from known noise senders. Same Gmail API, same service account, same auth.

**Scheduling:** macOS `launchd` (local, secure). Upgrade to Cloud Scheduler later.

## Implementation Tasks

### Task 1: Stop creating per-sender filters in execute-batch
**File:** `inbox-zero/src/review/execute-batch.ts`

Add `skipFilterCreation` option to `ExecuteBatchOptions` (default `true`). When true, set `filterStatus` to `"skipped"` for all senders. Archive step unchanged.

**Reuse:** Existing `advanceSenderStep()` for setting status to "skipped".
**Tests:** `tests/review/execute-batch.test.ts` — verify 0 `createFilter` calls when `skipFilterCreation: true`, verify archive still works.

### Task 2: Build the sweep module
**New file:** `inbox-zero/src/noise/sweep.ts`

```typescript
export interface SweepOptions {
  gmailClient: GmailClient;
  decisionLogPath: string;
  noiseLabelId: string;
  maxSendersPerQuery?: number;   // sender cap per OR query (default 25)
  maxQueryChars?: number;        // query length cap (default 1200)
  dryRun?: boolean;
  onProgress?: (info: { queriesSent: number; messagesSwept: number }) => void;
}

export interface SweepResult {
  queriesSent: number;
  messagesFound: number;
  messagesSwept: number;
  errors: string[];
}

export async function sweep(options: SweepOptions): Promise<Result<SweepResult>>;
```

Algorithm:
1. `collectNoiseSenders(decisionLogPath)` → latest decision per sender from decision log
2. Build OR-based Gmail queries via shared `buildOrQueries()`, bounded by sender-count and char-length caps
3. For each query: `messages.list(q="in:inbox (from:a@x.com OR from:b@y.com ...)")`
4. Paginate to collect all message IDs (bounded by safety cap of 100 pages)
5. `batchModifyMessages(ids, [noiseLabelId], ["INBOX"])`
6. Return totals

**Reuse:**
- `collectNoiseSenders()` from `src/state/decision-log-manager.ts`
- `buildOrQueries()` from `src/noise/query-builder.ts`
- `BATCH_MODIFY_CHUNK_SIZE`, `chunkArray()` from `src/utils.ts`
- `GmailClient.listMessages()` and `batchModifyMessages()` from `src/auth/gmail-client.ts`

**Tests:** `tests/noise/sweep.test.ts` — mock Gmail client, verify:
- Correct OR-based `in:inbox (from:...)` query construction
- Batching respects sender-count and query-length caps
- batchModify called with correct label IDs
- Dry-run mode makes no API mutations
- Empty decision log = no queries sent
- Latest decision wins when sender appears multiple times
- `keep` senders are excluded

### Task 3: Add `sweep` CLI command
**File:** `inbox-zero/src/cli.ts`

```bash
npm run cli -- sweep [--dry-run] [--max-senders-per-query <n>] [--max-query-chars <n>]
```

1. Load env, create GmailClient with service account
2. `ensureNoiseLabel()`
3. Call `sweep()` from the sweep module
4. Report: "Swept N messages from M noise senders in Q queries."

**Reuse:** Same `runCommand()` wrapper and env loading as other CLI commands.

### Task 4: Add `deleteFilter` to GmailClient
**File:** `inbox-zero/src/auth/gmail-client.ts`

```typescript
async deleteFilter(filterId: string): Promise<Result<void>>
```

Wraps `this.api.users.settings.filters.delete({ userId: "me", id: filterId })` with existing rate-limiting and retry logic.

**Tests:** `tests/auth/gmail-client.test.ts`

### Task 5: Build filter consolidation + migration
**New file:** `inbox-zero/src/noise/filter-consolidator.ts`

Two core functions:

1. **`buildConsolidatedQueries(senders: string[], maxChars?: number): string[]`**
   Groups sender emails into batches where each consolidated Gmail `criteria.query` stays within the shared conservative cap (`DEFAULT_MAX_QUERY_CHARS`, currently 1,200 chars).
   Uses `from:a@x.com OR from:b@y.com` syntax so the query can be passed directly to Gmail filter `criteria.query`.

2. **`migrateFilters(client, decisionLogPath, noiseLabelId, options): Promise<Result<MigrationResult>>`**
   - Lists all existing filters via `listFilters()`
   - Identifies per-sender noise filters (those matching latest noise decisions from the decision log)
   - Groups those senders into consolidated `criteria.query` batches
   - Creates new consolidated filters
   - Deletes old per-sender filters via `deleteFilter()`
   - Returns report: filters created, filters deleted, filter slots freed

**CLI command:** `inbox-zero migrate-filters [--dry-run] [--execute]`

Dry-run by default. Shows what would change. Requires `--execute` for actual migration.

**Reuse:** `ensureNoiseLabel()`, `readDecisionLog()`, `listFilters()`, `createFilter()`, `deleteFilter()`.
**Tests:** `tests/noise/filter-consolidator.test.ts`

### Task 6: Set up launchd scheduling
**New file:** `inbox-zero/com.house-keeping.inbox-zero-sweep.example.plist`

A `launchd` plist that runs `inbox-zero sweep` every 15 minutes:
- Working directory: `inbox-zero/`
- Env vars: `GOOGLE_SERVICE_ACCOUNT_KEY`, `GMAIL_USER`
- Log output to `~/Library/Logs/house-keeping/inbox-zero/sweep.out.log` and `sweep.err.log`
- `RunAtLoad: true` (runs immediately on login)
- `StartInterval: 900` (every 15 minutes)

Install: generate the local plist from the template with `GMAIL_USER=you@example.com bash scripts/install-sweep-plist.sh`, then `launchctl load ~/Library/LaunchAgents/com.house-keeping.inbox-zero-sweep.plist`

**Docs:** Add a "Scheduling" section to HANDOVER.md with install/uninstall/status commands.

## Execution Order

```text
Task 1 (skip filters)  ──┐
                          ├──→ can parallelize
Task 2 (sweep module)  ──┘
         │
         ▼
Task 3 (sweep CLI)     ──→ depends on Task 2
         │
         ▼
Task 6 (launchd)       ──→ depends on Task 3

Task 4 (deleteFilter)  ──┐
                          ├──→ can parallelize with Tasks 1-3
Task 5 (consolidation) ──┘    depends on Task 4
```

**Parallel track A:** Tasks 1 → done (quick)
**Parallel track B:** Tasks 2 → 3 → 6 (sweep pipeline)
**Parallel track C:** Tasks 4 → 5 (filter migration)

Tracks A+B unblock the review workflow. Track C is cleanup of existing filters.

## What changes for the review workflow

**Nothing.** Same conversational review loop:
1. Present senders → user decides keep/filter/unsubscribe
2. Create manifest → execute-batch (archive only, filter step skipped)
3. Sweep catches future noise automatically every 15 min

## Ongoing maintenance model

- **launchd (every 15 min):** `inbox-zero sweep` — primary noise prevention, runs while Mac is on
- **Source of truth for sweep:** decision log — sweep reads the latest reviewed decisions from it, no separate config
- **Filter budget:** ~950 slots freed after migration → ~25 used for consolidated high-volume filters, ~975 available
- **Future:** Upgrade to Cloud Scheduler for 24/7 coverage

## Verification

1. **Task 1:** Run `execute-batch` on a test manifest → verify 0 filter API calls, archive works
2. **Task 2+3:** `inbox-zero sweep --dry-run` → shows messages it would archive. Then run for real → messages archived
3. **Task 4+5:** `inbox-zero migrate-filters --dry-run` → shows "Would consolidate 947 → 22 filters". Then `--execute` → filter count drops
4. **Task 6:** `launchctl list | grep inbox-zero` → plist loaded. Check `~/Library/Logs/house-keeping/inbox-zero/sweep.out.log` and `sweep.err.log` for sweep output

## Critical files

| File | Change |
|------|--------|
| `src/review/execute-batch.ts` | Add `skipFilterCreation` option |
| `src/noise/sweep.ts` | **New** — sweep module |
| `src/noise/filter-consolidator.ts` | **New** — consolidation + migration |
| `src/auth/gmail-client.ts` | Add `deleteFilter()` method |
| `src/cli.ts` | Add `sweep` and `migrate-filters` commands |
| `com.house-keeping.inbox-zero-sweep.example.plist` | **New** — launchd schedule template |
| `scripts/install-sweep-plist.sh` | **New** — generates local launchd plist with real path/env |
| `src/noise/filter-creator.ts` | Reuse `ensureNoiseLabel()` |
| `src/state/decision-log-manager.ts` | Reuse `collectNoiseSenders()` |
| `src/utils.ts` | Reuse `chunkArray()` |
