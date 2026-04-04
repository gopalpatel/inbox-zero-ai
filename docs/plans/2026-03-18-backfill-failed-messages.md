# Plan: Reliable Backfill CLI

## Context

During the 671k-message Gmail metadata pull, ~73k messages failed metadata parsing. PR #5 fixed the two known root causes:

- bare angle-bracket headers like `<email@example.com>`
- Zod's default email validator rejecting valid RFC 5322 `atext` characters

The next step is not just "retry the failed IDs". It needs to be a reliable repair workflow:

- resumable after interruption
- idempotent across reruns
- efficient at the scale of failed IDs, not total mailbox size
- safe to share as part of an open-source tool

The current failures live in `checkpoint.json.errors`. After backfill, that list should shrink to the true residual failures so the retry set gets smaller over time.

## Reliability Goals

1. Never create duplicate canonical `EmailMetadata` records if backfill is interrupted and rerun.
2. Resume automatically from an incomplete backfill run without re-fetching already recovered messages.
3. Preserve non-message/system errors already stored in `checkpoint.errors`.
4. Reduce `checkpoint.errors` to residual message-level failures only after a completed backfill.
5. Stay backward-compatible with existing checkpoints that only have free-form error messages.
6. Keep the process efficient: work should scale with failed IDs, not all pulled mail.

## Approach

Build `backfill` as a two-phase repair pipeline with a dedicated run directory:

1. **Fetch + stage**
   - snapshot the target failed message IDs from `checkpoint.errors`
   - fetch only those IDs
   - append recovered `EmailMetadata` rows to a run-scoped staging file

2. **Promote**
   - dedupe staged rows by `messageId`
   - write run-scoped backfill shard files
   - mark the backfill run complete
   - rewrite `checkpoint.errors` so recovered message-level failures are removed and only residual failures remain

Canonical data stays append-only:

- main pull output remains in root `batch-*.json`
- backfill output lives under `data/backfills/<runId>/`
- `loadAllBatches()` becomes the source of truth by loading:
  - root pull batches
  - completed backfill runs only

This avoids the unsafe "continue batch numbering from checkpoint" pattern and removes any dependency on `checkpoint.batchesSaved` staying perfectly in sync during a crash.

## Files

| File | Action |
|------|--------|
| `src/pull/message-parser.ts` | Fix `parseAddressList` comma-split bug (closes #6) |
| `tests/pull/message-parser.test.ts` | Add quoted-display-name-with-comma tests |
| `tests/fixtures/sample-gmail-response.ts` | Add fixture with comma-in-display-name To/Cc |
| `src/pull/pull-constants.ts` | **New** — shared `METADATA_HEADERS` and `MAX_CONCURRENT` |
| `src/schemas/checkpoint.ts` | Export `CheckpointErrorSchema`; add optional `kind` and `messageId` for future pulls |
| `tests/schemas/checkpoint.test.ts` | Cover backward-compatible checkpoint parsing |
| `src/schemas/backfill-checkpoint.ts` | **New** — schema for durable backfill run state |
| `tests/schemas/backfill-checkpoint.test.ts` | **New** — schema tests |
| `src/pull/checkpoint-manager.ts` | Extend loader to include completed backfill run shards |
| `tests/pull/checkpoint-manager.test.ts` | Add mixed root-batch + completed-backfill loading tests |
| `src/pull/backfill.ts` | **New** — fetch/stage/promote backfill engine |
| `tests/pull/backfill.test.ts` | **New** — TDD tests for resume, promotion, checkpoint rewrite |
| `src/cli.ts` | Wire `backfill` subcommand |

## Key Design Decisions

1. **Backfill is resumable by default**
   - No "best effort rerun".
   - The command resumes from a dedicated `backfill-checkpoint.json` inside the run directory.

2. **Canonical data is append-only**
   - Main `batch-*.json` files are never overwritten by backfill.
   - Backfill writes its own shard files under `data/backfills/<runId>/`.

3. **Only completed backfill runs count as canonical**
   - `loadAllBatches()` must ignore incomplete or failed backfill runs.
   - This makes partial promote crashes safe.

4. **`checkpoint.errors` remains the canonical retry source**
   - Do not clear it wholesale.
   - On successful backfill completion:
     - remove recovered message-level failures
     - keep residual message-level failures
     - preserve non-message/system errors unchanged

5. **Backward-compatible ID extraction**
   - New pulls should record `messageId` explicitly in checkpoint errors.
   - Backfill first uses `error.messageId`.
   - For existing checkpoints, fallback regex is `^Message ([^:]+):`, not a hex-only pattern.

6. **No global mailbox re-scan on every backfill**
   - Resume is driven by:
     - the run's target ID snapshot
     - deduped staged successes
   - Runtime stays proportional to failed IDs.

7. **Drift detection**
   - A backfill run snapshots the source checkpoint state.
   - If the main checkpoint changes before resume, `backfill` should refuse to continue unless the user passes `--restart`.

8. **Do not reuse `checkpoint.batchesSaved` for backfill writes**
   - Root pull batches and backfill shards are different artifact families.
   - Backfill tracks its own `shardsWritten`.
   - `checkpoint.messagesFetched` should increase after promotion; `batchesSaved` can remain a main-pull metric.

## Directory Layout

```text
data/
  checkpoint.json
  batch-00001.json
  batch-00002.json
  backfills/
    <runId>/
      backfill-checkpoint.json
      recovered.jsonl
      report.json
      batch-00001.json
      batch-00002.json
```

Notes:

- Root `batch-*.json` files come from the main metadata pull.
- `data/backfills/<runId>/batch-*.json` are run-scoped backfill shards.
- Only run directories whose checkpoint status is `complete` are loaded as canonical data.

## Schema Changes

### `src/schemas/checkpoint.ts`

Add an exported `CheckpointErrorSchema` and make it future-proof:

```typescript
CheckpointErrorSchema = z.object({
  timestamp: z.coerce.date(),
  message: z.string(),
  pageToken: z.string().nullable(),
  kind: z.enum(["message", "system"]).optional(),
  messageId: z.string().optional(),
});
```

Compatibility rules:

- existing checkpoint files still parse because `kind` and `messageId` are optional
- metadata puller should start writing `kind: "message"` + `messageId` for per-message failures
- list/save/checkpoint failures should remain `kind: "system"` or omit `messageId`

### `src/schemas/backfill-checkpoint.ts`

```typescript
BackfillCheckpointSchema = z.object({
  runId: z.string(),
  status: z.enum(["fetching", "promoting", "complete", "failed"]),
  sourceCheckpointLastSavedAt: z.coerce.date(),
  sourceErrorFingerprint: z.string(),
  targetIds: z.array(z.string()),
  recoveredCount: z.number().int().nonnegative(),
  residualErrors: z.array(
    z.object({
      messageId: z.string(),
      error: z.string(),
      timestamp: z.coerce.date(),
    }),
  ).default([]),
  shardsWritten: z.number().int().nonnegative(),
  lastSavedAt: z.coerce.date(),
});
```

`targetIds` is acceptable here: ~73k IDs is only a few MB, and keeping the snapshot in the run state makes resume deterministic.

## Implementation — `src/pull/backfill.ts`

### Shared helpers

#### `extractMessageIds(errors): string[]`

- Prefer `error.messageId` when present
- Fallback to `^Message ([^:]+):` for legacy checkpoints
- Deduplicate with `Set`
- Return stable sorted output

#### `fingerprintTargetIds(ids): string`

- Hash sorted IDs with `node:crypto`
- Used to detect source checkpoint drift across resumes

#### `loadRecoveredMap(runDir): Promise<Map<string, EmailMetadata>>`

- Read `recovered.jsonl`
- Parse line-delimited JSON
- Keep the latest row per `messageId`
- This makes append-before-crash safe: duplicate stage lines collapse during resume/promotion

### `backfill(options): Promise<Result<BackfillResult>>`

```typescript
BackfillOptions {
  client,
  dataDir,
  restart?,
  onProgress?,
}

BackfillProgress {
  processed,
  total,
  recovered,
  stillFailing,
  phase, // "fetching" | "promoting"
}

BackfillResult {
  runId,
  totalIds,
  recovered,
  stillFailing,
  shardsWritten,
  residualErrors,
  reportPath,
}
```

### Algorithm

1. Load main `checkpoint.json`
2. Guard: `checkpoint.status` must be `complete`
3. Split checkpoint errors into:
   - message-level retry candidates
   - non-message/system errors to preserve
4. Extract + dedupe target IDs
5. Load existing backfill run state
   - if none: create new run dir + snapshot
   - if existing and fingerprint matches: resume
   - if existing and fingerprint differs:
     - refuse by default
     - allow `--restart` to create a fresh run from the new checkpoint state
6. Load staged recoveries from `recovered.jsonl`
7. Compute `remainingIds = targetIds - recoveredIds`
8. Fetch remaining IDs with bounded concurrency
   - `client.getMessage(id, "metadata", METADATA_HEADERS)`
   - `parseGmailMessage(raw)`
   - success:
     - append `{ messageId, email }` to `recovered.jsonl`
   - failure:
     - upsert residual error for that `messageId` in run state
9. Persist run checkpoint periodically during fetch
10. Promote phase:
    - read + dedupe staged recoveries by `messageId`
    - write deterministic run-scoped shard files:
      - `data/backfills/<runId>/batch-00001.json`
      - `data/backfills/<runId>/batch-00002.json`
    - write `report.json`
    - mark run checkpoint `status: "complete"`
11. Rewrite main checkpoint:
    - `messagesFetched += uniqueRecoveredCount`
    - `errors = preservedSystemErrors + residualMessageErrors`
    - `lastSavedAt = new Date()`
12. Return counts

## Why This Is Crash-Safe

### Fetch phase

- successes are append-only in `recovered.jsonl`
- resume rebuilds recovered state by reading and deduping that file
- crash after append does not lose work
- crash before checkpoint write does not cause duplicate canonical records because nothing has been promoted yet

### Promote phase

- promote writes only into the run directory
- incomplete runs are ignored by `loadAllBatches()`
- rerunning promotion for the same `runId` rewrites the same run-scoped shard files deterministically
- no root pull batch is ever overwritten

### Restart behavior

- `backfill --restart` creates a new run from the current checkpoint snapshot
- older incomplete runs remain ignored because only `status: "complete"` runs are loaded

## `loadAllBatches()` Change

Extend `checkpoint-manager.ts` so canonical loading becomes:

1. load root `batch-*.json`
2. inspect `data/backfills/*/backfill-checkpoint.json`
3. include only runs with `status === "complete"`
4. load their run-scoped `batch-*.json`
5. combine and validate all `EmailMetadata`

This keeps analysis/reporting code unchanged while making backfill runs first-class canonical data.

## Tests — `tests/pull/backfill.test.ts`

### `extractMessageIds()` (6 tests)

- Extracts IDs from structured `messageId`
- Falls back to legacy `Message <id>:` format
- Deduplicates repeated IDs
- Returns empty for empty input
- Ignores system errors without message IDs
- Handles mixed structured + legacy errors

### Run state / drift (5 tests)

- Creates a new run when none exists
- Resumes an existing run when fingerprint matches
- Refuses resume when source checkpoint changed
- Allows `--restart` on changed checkpoint
- Ignores previously staged successes when resuming

### Fetch phase (6 tests)

- Fetches each remaining ID via `getMessage(..., "metadata", METADATA_HEADERS)`
- Parses with `parseGmailMessage`
- Appends successes to `recovered.jsonl`
- Continues when `getMessage` fails for some IDs
- Continues when parse fails for some IDs
- Emits progress in `fetching` phase

### Promote phase (6 tests)

- Dedupe staged recoveries by `messageId`
- Writes deterministic run-scoped shards at `BATCH_SIZE`
- Overwrites same run's shard files safely on repeated promote
- Writes `report.json`
- Marks run `complete`
- Emits progress in `promoting` phase

### Main checkpoint rewrite (5 tests)

- Removes recovered message-level errors
- Keeps residual message-level errors
- Preserves non-message/system errors untouched
- Increments `messagesFetched` by unique recovered count
- Leaves `batchesSaved` unchanged

### Loader integration (4 tests)

- `loadAllBatches()` includes completed backfill runs
- `loadAllBatches()` ignores incomplete backfill runs
- `loadAllBatches()` ignores failed backfill runs
- Combined root + backfill shards validate as `EmailMetadata`

### Hard-failure handling (3 tests)

- Returns error when backfill run checkpoint save fails
- Returns error when promote shard write fails
- Returns error when main checkpoint rewrite fails

## CLI Wiring — `src/cli.ts`

```typescript
program
  .command("backfill")
  .description("Recover failed message-level metadata pulls from a completed checkpoint")
  .option("--restart", "Discard any in-progress backfill run and start from current checkpoint errors")
```

Behavior:

- same `runCommand`, `createGmailClient`, `DATA_DIR` pattern as `pull`
- logs phase-aware progress:
  - `Backfill [fetching]: N/M processed, K recovered, J still failing`
  - `Backfill [promoting]: shard X/Y`

## Fix: Comma-Split in `parseAddressList` (closes #6)

### Problem

`parseAddressList` currently uses `.split(",")`, which breaks:

- `"Smith, John" <john@example.com>, jane@example.com`

### Fix

Replace naive split with a quote-aware splitter.

```typescript
function splitAddresses(value: string): string[] {
  const results: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      results.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  results.push(current);
  return results;
}
```

Safety:

- bounded by existing `MAX_HEADER_LENGTH` truncation
- no regex added
- linear scan only

### Tests

- `"Smith, John" <john@example.com>, jane@example.com` → 2 addresses
- `alice@example.com, bob@example.com` → 2 addresses
- `"A, B" <a@x.com>, "C, D" <c@x.com>` → 2 addresses
- fixture-backed parser test with comma-bearing display names in `To` and `Cc`

## Implementation Order

1. Extract shared pull constants into `src/pull/pull-constants.ts`
2. Add `CheckpointErrorSchema` export and optional `kind` / `messageId`
3. Add checkpoint schema backward-compat tests
4. Fix `parseAddressList` comma-split + tests (closes #6)
5. Add `BackfillCheckpointSchema` + schema tests
6. Extend `loadAllBatches()` to load completed backfill runs
7. Write `extractMessageIds` + fingerprint tests
8. Implement fetch/stage phase
9. Implement promote phase
10. Implement main checkpoint rewrite
11. Wire CLI `backfill` subcommand with `--restart`
12. Full test suite + typecheck

## Verification

1. `npm test` — full suite passes
2. `npx tsc --noEmit` — typecheck passes
3. Start with a checkpoint containing failed message-level errors
4. Run `npm run cli -- backfill`
5. Interrupt mid-run, rerun `npm run cli -- backfill`, verify:
   - already staged successes are skipped
   - no duplicate canonical records appear
6. After completion, verify:
   - `checkpoint.errors` is smaller and contains only residual message-level failures plus preserved system errors
   - `data/backfills/<runId>/backfill-checkpoint.json` is `complete`
   - `loadAllBatches()` includes recovered messages
7. Run `npm run cli -- backfill` again with no new checkpoint failures and confirm it is a no-op
