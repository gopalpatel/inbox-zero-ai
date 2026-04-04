/**
 * FilterConsolidator — consolidates per-sender Gmail filters into batched
 * query-based filters to free up filter slots.
 *
 * Gmail has a hard limit of 1000 filters. When the inbox-zero pipeline creates
 * one filter per noise sender, that limit is consumed quickly. This module:
 *
 * 1. Groups senders into consolidated `from:a OR from:b` queries.
 * 2. Creates new query-based filters that replace many per-sender filters.
 * 3. Deletes the now-redundant per-sender filters.
 *
 * Design decisions:
 * - Consolidated queries use `criteria.query` (not `criteria.from`) because
 *   Gmail's `from` field only accepts a single address, while `query` supports
 *   full search syntax including OR operators.
 * - Senders are partitioned by action type (filter vs unsubscribe) since they
 *   have different `removeLabelIds`.
 * - Default migration uses a safe create-then-delete pattern: consolidated
 *   filters are created first, then old per-sender filters are deleted.
 * - `--delete-first` mode reverses the order for when no headroom is available.
 *   It freezes delete/create targets to a snapshot file before mutating Gmail,
 *   enabling crash-safe resume on rerun.
 * - Requires explicit `mode: "execute"` to mutate — dry-run by default.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "../auth/gmail-client.js";
import { collectNoiseSenders, latestDecisionsBySender, readDecisionLog } from "../state/decision-log-manager.js";
import type { Result } from "../types.js";
import { atomicWriteFile } from "../utils.js";
import { buildOrQueries, buildOrQueryPlans } from "./query-builder.js";

const MAX_GMAIL_FILTERS = 1_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Statistics returned after a filter-consolidation migration run. */
export interface MigrationResult {
  filtersCreated: number;
  filtersDeleted: number;
  /** Net slots freed = deleted - created. May be negative if no per-sender filters existed. */
  slotsFreed: number;
  errors: string[];
}

/** Options for {@link migrateFilters}; controls dry-run vs execute mode. */
export interface MigrateFiltersOptions {
  mode: "dry-run" | "execute";
  /** Delete per-sender filters before creating consolidated replacements. */
  deleteFirst?: boolean;
}

// ---------------------------------------------------------------------------
// Delete-first snapshot — frozen migration plan persisted to disk
// ---------------------------------------------------------------------------

/** Target for a per-sender filter to delete during delete-first migration. */
interface DeleteTarget {
  filterId: string;
  senderEmail?: string;
  kind: "legacy-noise" | "stale-keep";
}

/** Target for a consolidated filter to create during delete-first migration. */
interface CreateTarget {
  query: string;
  senders: string[];
  removeLabelIds: string[];
}

/** Frozen delete-first migration plan persisted to `<dataDir>/filter-migrations/delete-first.json`. */
export interface DeleteFirstPlan {
  version: 1;
  strategy: "delete-first";
  createdAt: string;
  noiseLabelId: string;
  deleteTargets: DeleteTarget[];
  createTargets: CreateTarget[];
}

/**
 * Returns the path to the delete-first snapshot file, derived from the
 * decision log path so it sits next to the rest of the durable local state.
 */
export function getDeleteFirstPlanPath(decisionLogPath: string): string {
  const dataDir = path.dirname(decisionLogPath);
  return path.join(dataDir, "filter-migrations", "delete-first.json");
}

/**
 * Reads and parses the delete-first snapshot. Returns `null` if the file
 * does not exist. Returns an error for corrupt/unparseable JSON.
 */
export async function readDeleteFirstPlan(filePath: string): Promise<Result<DeleteFirstPlan | null>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isDeleteFirstPlan(parsed)) {
      return { ok: false, error: `Corrupt delete-first snapshot at ${filePath}: invalid structure` };
    }
    return { ok: true, value: parsed };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      error: `Failed to read delete-first snapshot at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Atomically writes a delete-first snapshot to disk. */
export async function writeDeleteFirstPlan(filePath: string, plan: DeleteFirstPlan): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(plan, null, 2));
}

/** Removes the delete-first snapshot after a successful migration. */
export async function deleteDeleteFirstPlan(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// buildConsolidatedQueries — thin wrapper over shared buildOrQueries
// ---------------------------------------------------------------------------

/**
 * Groups sender emails into batches where each batch's Gmail query
 * fits within the character limit. Returns query strings for criteria.query.
 *
 * Each returned string is a Gmail filter query like:
 *   `from:a@x.com OR from:b@y.com OR from:c@z.com`
 *
 * Algorithm:
 * 1. For each sender, the fragment is `from:sender@example.com`
 * 2. Fragments are joined by ` OR `
 * 3. Keep adding senders until the total length exceeds `maxChars`, then start a new batch
 * 4. Guarantee at least one sender per batch (even if a single sender exceeds maxChars)
 * 5. Empty input returns empty array
 */
export function buildConsolidatedQueries(senders: string[], maxChars?: number): string[] {
  return buildOrQueries([...senders].sort(), { maxChars });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Action type key for partitioning senders. */
type ActionType = "filter" | "unsubscribe";

interface ActionGroup {
  action: ActionType;
  senders: string[];
  removeLabelIds: string[];
}

function normalizeLabelIds(labelIds?: string[] | null): string[] {
  return [...new Set(labelIds ?? [])].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDeleteTarget(value: unknown): value is DeleteTarget {
  if (!isRecord(value)) return false;
  if (typeof value["filterId"] !== "string" || value["filterId"].length === 0) return false;
  if (value["senderEmail"] !== undefined && typeof value["senderEmail"] !== "string") return false;
  return value["kind"] === "legacy-noise" || value["kind"] === "stale-keep";
}

function isCreateTarget(value: unknown): value is CreateTarget {
  if (!isRecord(value)) return false;
  if (typeof value["query"] !== "string" || value["query"].length === 0) return false;
  if (!isStringArray(value["senders"]) || value["senders"].length === 0) return false;
  return isStringArray(value["removeLabelIds"]);
}

function isDeleteFirstPlan(value: unknown): value is DeleteFirstPlan {
  if (!isRecord(value)) return false;
  if (value["version"] !== 1 || value["strategy"] !== "delete-first") return false;
  if (typeof value["createdAt"] !== "string" || value["createdAt"].length === 0) return false;
  if (typeof value["noiseLabelId"] !== "string" || value["noiseLabelId"].length === 0) return false;
  if (!Array.isArray(value["deleteTargets"]) || !value["deleteTargets"].every(isDeleteTarget)) return false;
  return Array.isArray(value["createTargets"]) && value["createTargets"].every(isCreateTarget);
}

function matchesExactAction(filter: gmail_v1.Schema$Filter, noiseLabelId: string, removeLabelIds: string[]): boolean {
  const addLabels = normalizeLabelIds(filter.action?.addLabelIds);
  const removeLabels = normalizeLabelIds(filter.action?.removeLabelIds);

  if (addLabels.length !== 1 || addLabels[0] !== noiseLabelId) {
    return false;
  }

  const expectedRemoveLabels = normalizeLabelIds(removeLabelIds);
  if (removeLabels.length !== expectedRemoveLabels.length) {
    return false;
  }

  return removeLabels.every((label, index) => label === expectedRemoveLabels[index]);
}

/**
 * Checks whether an existing Gmail filter is a per-sender noise filter
 * that we created. The filter must:
 * - Have a `criteria.from` that matches a known noise sender (case-insensitive)
 * - Have one of the exact action signatures our pipeline uses
 */
function isPerSenderNoiseFilter(
  filter: gmail_v1.Schema$Filter,
  noiseSenderSet: Set<string>,
  noiseLabelId: string,
): boolean {
  const from = filter.criteria?.from;
  if (typeof from !== "string" || from.length === 0) return false;

  // Check case-insensitive match against known noise senders
  if (!noiseSenderSet.has(from.toLowerCase())) return false;

  return (
    matchesExactAction(filter, noiseLabelId, ["INBOX"]) || matchesExactAction(filter, noiseLabelId, ["INBOX", "UNREAD"])
  );
}

function hasEquivalentConsolidatedFilter(
  filters: gmail_v1.Schema$Filter[],
  query: string,
  noiseLabelId: string,
  removeLabelIds: string[],
): boolean {
  return filters.some((filter) => {
    if (filter.criteria?.query !== query) {
      return false;
    }

    return matchesExactAction(filter, noiseLabelId, removeLabelIds);
  });
}

function buildDeleteFirstPlan(
  noiseLabelId: string,
  staleKeptFilters: gmail_v1.Schema$Filter[],
  perSenderFilters: gmail_v1.Schema$Filter[],
  plannedCreates: Array<{
    senders: string[];
    query: string;
    removeLabelIds: string[];
  }>,
): DeleteFirstPlan {
  const deleteTargets: DeleteTarget[] = [];

  for (const filter of staleKeptFilters) {
    if (typeof filter.id !== "string") continue;
    deleteTargets.push({
      filterId: filter.id,
      senderEmail: filter.criteria?.from ?? undefined,
      kind: "stale-keep",
    });
  }

  for (const filter of perSenderFilters) {
    if (typeof filter.id !== "string") continue;
    deleteTargets.push({
      filterId: filter.id,
      senderEmail: filter.criteria?.from ?? undefined,
      kind: "legacy-noise",
    });
  }

  const createTargets: CreateTarget[] = plannedCreates.map((planned) => ({
    query: planned.query,
    senders: planned.senders,
    removeLabelIds: planned.removeLabelIds,
  }));

  return {
    version: 1,
    strategy: "delete-first",
    createdAt: new Date().toISOString(),
    noiseLabelId,
    deleteTargets,
    createTargets,
  };
}

function getRemainingDeleteTargets(filters: gmail_v1.Schema$Filter[], plan: DeleteFirstPlan): DeleteTarget[] {
  const currentFilterIds = new Set(
    filters.map((filter) => filter.id).filter((filterId): filterId is string => typeof filterId === "string"),
  );

  return plan.deleteTargets.filter((target) => currentFilterIds.has(target.filterId));
}

function getRemainingCreateTargets(
  filters: gmail_v1.Schema$Filter[],
  noiseLabelId: string,
  plan: DeleteFirstPlan,
): CreateTarget[] {
  return plan.createTargets.filter(
    (target) => !hasEquivalentConsolidatedFilter(filters, target.query, noiseLabelId, target.removeLabelIds),
  );
}

function buildDeleteFirstDryRunResult(
  existingFilters: gmail_v1.Schema$Filter[],
  plan: DeleteFirstPlan,
): MigrationResult {
  const remainingDeletes = getRemainingDeleteTargets(existingFilters, plan);
  const remainingCreates = getRemainingCreateTargets(existingFilters, plan.noiseLabelId, plan);
  const projectedFilterCount = existingFilters.length - remainingDeletes.length;
  const projectedHeadroom = MAX_GMAIL_FILTERS - projectedFilterCount;
  const errors: string[] = [];

  if (remainingCreates.length > projectedHeadroom) {
    errors.push(
      `Not enough projected headroom after delete-first: ${projectedFilterCount} filters would remain, ${remainingCreates.length} consolidated filters needed, ${projectedHeadroom} slots available.`,
    );
  }

  return {
    filtersCreated: remainingCreates.length,
    filtersDeleted: remainingDeletes.length,
    slotsFreed: remainingDeletes.length - remainingCreates.length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// migrateFilters
// ---------------------------------------------------------------------------

/**
 * Migrates per-sender Gmail noise filters into consolidated query-based filters.
 *
 * Reads the decision log, identifies noise senders with existing per-sender
 * filters, groups them into consolidated queries, creates new filters, and
 * deletes the old ones.
 *
 * Requires `mode: "execute"` to actually make changes. Without it (or with
 * `mode: "dry-run"`), reports what would happen.
 */
export async function migrateFilters(
  client: GmailClient,
  decisionLogPath: string,
  noiseLabelId: string,
  options?: MigrateFiltersOptions,
): Promise<Result<MigrationResult>> {
  const isExecute = options?.mode === "execute";
  const isDeleteFirst = options?.deleteFirst === true;

  const emptyResult: MigrationResult = {
    filtersCreated: 0,
    filtersDeleted: 0,
    slotsFreed: 0,
    errors: [],
  };

  if (isDeleteFirst) {
    const snapshotPath = getDeleteFirstPlanPath(decisionLogPath);
    const snapshotResult = await readDeleteFirstPlan(snapshotPath);
    if (!snapshotResult.ok) {
      return { ok: false, error: snapshotResult.error };
    }

    if (snapshotResult.value !== null) {
      const filtersResult = await client.listFilters();
      if (!filtersResult.ok) {
        return { ok: false, error: filtersResult.error };
      }

      if (!isExecute) {
        return {
          ok: true,
          value: buildDeleteFirstDryRunResult(filtersResult.value, snapshotResult.value),
        };
      }

      return executeDeleteFirst(
        client,
        snapshotPath,
        noiseLabelId,
        filtersResult.value,
        snapshotResult.value,
      );
    }
  }

  // 1. Collect noise senders from the decision log
  const noiseResult = await collectNoiseSenders(decisionLogPath);
  if (!noiseResult.ok) {
    return { ok: false, error: noiseResult.error };
  }

  if (noiseResult.value === null) {
    return { ok: true, value: emptyResult };
  }

  const { filterSenders, unsubscribeSenders, allNoiseSenders } = noiseResult.value;

  // 2. Collect ALL senders from decision log (including keep) for stale-filter detection
  const logResult = await readDecisionLog(decisionLogPath);
  if (!logResult.ok) {
    return { ok: false, error: logResult.error };
  }

  if (logResult.value === null) {
    return { ok: true, value: emptyResult };
  }

  const allLatest = latestDecisionsBySender(logResult.value.decisions);
  const reKeptSenders = new Set<string>();
  for (const [email, entry] of allLatest) {
    if (entry.userDecision === "keep") {
      reKeptSenders.add(email.toLowerCase());
    }
  }

  // 3. List all existing Gmail filters
  const filtersResult = await client.listFilters();
  if (!filtersResult.ok) {
    return { ok: false, error: filtersResult.error };
  }

  const existingFilters = filtersResult.value;

  // 4. Identify existing per-sender noise filters (both active noise AND stale re-kept)
  const noiseSenderSet = new Set(allNoiseSenders.map((e) => e.toLowerCase()));
  const perSenderFilters: gmail_v1.Schema$Filter[] = [];
  const staleKeptFilters: gmail_v1.Schema$Filter[] = [];

  for (const filter of existingFilters) {
    if (isPerSenderNoiseFilter(filter, noiseSenderSet, noiseLabelId)) {
      perSenderFilters.push(filter);
    } else if (isPerSenderNoiseFilter(filter, reKeptSenders, noiseLabelId)) {
      // Stale filter for a sender whose latest decision is "keep"
      staleKeptFilters.push(filter);
    }
  }

  // 5. Restrict consolidated filters to senders that actually have legacy per-sender filters
  const sendersWithLegacyFilter = new Set<string>();
  for (const filter of perSenderFilters) {
    const from = filter.criteria?.from;
    if (typeof from === "string") {
      sendersWithLegacyFilter.add(from.toLowerCase());
    }
  }

  const legacyFilterSenders = filterSenders.filter((e) => sendersWithLegacyFilter.has(e.toLowerCase()));
  const legacyUnsubSenders = unsubscribeSenders.filter((e) => sendersWithLegacyFilter.has(e.toLowerCase()));

  // 6. Build action groups (only for senders with legacy filters)
  const actionGroups: ActionGroup[] = [];

  if (legacyFilterSenders.length > 0) {
    actionGroups.push({
      action: "filter",
      senders: legacyFilterSenders,
      removeLabelIds: ["INBOX"],
    });
  }

  if (legacyUnsubSenders.length > 0) {
    actionGroups.push({
      action: "unsubscribe",
      senders: legacyUnsubSenders,
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  }

  // 5. Compute what would be created (Fix 6: store for reuse in execution)
  const plannedCreates: Array<{
    senders: string[];
    query: string;
    addLabelIds: string[];
    removeLabelIds: string[];
    alreadyExists: boolean;
  }> = [];

  for (const group of actionGroups) {
    const plans = buildOrQueryPlans([...group.senders].sort());
    for (const plan of plans) {
      plannedCreates.push({
        senders: plan.senders,
        query: plan.query,
        addLabelIds: [noiseLabelId],
        removeLabelIds: group.removeLabelIds,
        alreadyExists: hasEquivalentConsolidatedFilter(existingFilters, plan.query, noiseLabelId, group.removeLabelIds),
      });
    }
  }

  // Regression fix: stale keep-filters are obsolete behavior, so they can be
  // deleted before create-before-delete headroom is evaluated.
  const currentFilterCount = existingFilters.length - staleKeptFilters.length;
  const missingCreates = plannedCreates.filter((planned) => !planned.alreadyExists).length;
  const availableHeadroom = MAX_GMAIL_FILTERS - currentFilterCount;
  const headroomError =
    missingCreates > availableHeadroom
      ? `Not enough Gmail filter headroom for create-before-delete migration even after deleting ${staleKeptFilters.length} stale keep filters: ${currentFilterCount} existing filters would remain, ${missingCreates} new consolidated filters needed, ${availableHeadroom} slots available.`
      : undefined;

  // 6. In dry-run mode: compute and report
  if (!isExecute) {
    const wouldCreate = missingCreates;
    const wouldDelete = perSenderFilters.length + staleKeptFilters.length;

    // For delete-first, compute projected post-delete headroom instead of
    // the create-before-delete headroom error (which doesn't apply).
    const dryRunErrors: string[] = [];
    if (isDeleteFirst) {
      const projectedFilterCount = existingFilters.length - wouldDelete;
      const projectedHeadroom = MAX_GMAIL_FILTERS - projectedFilterCount;
      if (wouldCreate > projectedHeadroom) {
        dryRunErrors.push(
          `Not enough projected headroom after delete-first: ${projectedFilterCount} filters would remain, ${wouldCreate} consolidated filters needed, ${projectedHeadroom} slots available.`,
        );
      }
    } else if (headroomError !== undefined) {
      dryRunErrors.push(headroomError);
    }

    return {
      ok: true,
      value: {
        filtersCreated: wouldCreate,
        filtersDeleted: wouldDelete,
        slotsFreed: wouldDelete - wouldCreate,
        errors: dryRunErrors,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Delete-first execute path — snapshot-driven, resumable
  // ---------------------------------------------------------------------------

  if (isDeleteFirst) {
    return executeDeleteFirst(
      client,
      getDeleteFirstPlanPath(decisionLogPath),
      noiseLabelId,
      existingFilters,
      null,
      staleKeptFilters,
      perSenderFilters,
      plannedCreates,
    );
  }

  // ---------------------------------------------------------------------------
  // Default create-before-delete execute path (unchanged)
  // ---------------------------------------------------------------------------

  if (headroomError !== undefined) {
    return { ok: false, error: headroomError };
  }

  const errors: string[] = [];
  let filtersCreated = 0;
  let filtersDeleted = 0;

  // Stale keep-filters are safe to delete first because they intentionally
  // remove obsolete auto-archive behavior and do not need replacement coverage.
  let staleKeptDeleted = 0;
  for (const filter of staleKeptFilters) {
    const filterId = filter.id;
    if (typeof filterId !== "string") continue;

    try {
      const deleteResult = await client.deleteFilter(filterId);
      if (!deleteResult.ok) {
        errors.push(`Failed to delete stale kept filter ${filterId}: ${deleteResult.error}`);
      } else {
        filtersDeleted++;
        staleKeptDeleted++;
      }
    } catch (err: unknown) {
      errors.push(`deleteFilter threw for stale ${filterId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const currentFilterCountAfterStaleDeletes = existingFilters.length - staleKeptDeleted;
  const availableHeadroomAfterStaleDeletes = MAX_GMAIL_FILTERS - currentFilterCountAfterStaleDeletes;
  if (missingCreates > availableHeadroomAfterStaleDeletes) {
    errors.push(
      `Not enough Gmail filter headroom after deleting stale keep filters: ${currentFilterCountAfterStaleDeletes} existing filters remain, ${missingCreates} new consolidated filters needed, ${availableHeadroomAfterStaleDeletes} slots available.`,
    );

    return {
      ok: true,
      value: {
        filtersCreated,
        filtersDeleted,
        slotsFreed: filtersDeleted - filtersCreated,
        errors,
      },
    };
  }

  // Senders covered by an already-existing or newly-created consolidated filter.
  const coveredSenders = new Set<string>();

  for (const planned of plannedCreates) {
    if (planned.alreadyExists) {
      for (const sender of planned.senders) {
        coveredSenders.add(sender.toLowerCase());
      }
      continue;
    }

    try {
      const createResult = await client.createFilter(
        { query: planned.query },
        { addLabelIds: planned.addLabelIds, removeLabelIds: planned.removeLabelIds },
      );

      if (!createResult.ok) {
        errors.push(`Failed to create consolidated filter: ${createResult.error}`);
      } else {
        filtersCreated++;
        for (const sender of planned.senders) {
          coveredSenders.add(sender.toLowerCase());
        }
      }
    } catch (err: unknown) {
      errors.push(`createFilter threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Delete per-sender filters that are now covered by consolidated filters
  for (const filter of perSenderFilters) {
    const from = filter.criteria?.from;
    if (typeof from !== "string") continue;

    if (!coveredSenders.has(from.toLowerCase())) continue;

    const filterId = filter.id;
    if (typeof filterId !== "string") continue;

    try {
      const deleteResult = await client.deleteFilter(filterId);
      if (!deleteResult.ok) {
        errors.push(`Failed to delete filter ${filterId}: ${deleteResult.error}`);
      } else {
        filtersDeleted++;
      }
    } catch (err: unknown) {
      errors.push(`deleteFilter threw for ${filterId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: true,
    value: {
      filtersCreated,
      filtersDeleted,
      slotsFreed: filtersDeleted - filtersCreated,
      errors,
    },
  };
}

// ---------------------------------------------------------------------------
// executeDeleteFirst — snapshot-driven resumable delete-first migration
// ---------------------------------------------------------------------------

/**
 * Implements the delete-first migration strategy:
 * 1. Load or create a frozen snapshot of delete/create targets
 * 2. Delete all per-sender filters (stale keep + legacy noise)
 * 3. Refresh Gmail filters and verify headroom
 * 4. Create consolidated filters
 * 5. Verify all targets satisfied against live Gmail
 * 6. Delete snapshot only on full success
 */
async function executeDeleteFirst(
  client: GmailClient,
  snapshotPath: string,
  noiseLabelId: string,
  existingFilters: gmail_v1.Schema$Filter[],
  existingPlan: DeleteFirstPlan | null,
  staleKeptFilters?: gmail_v1.Schema$Filter[],
  perSenderFilters?: gmail_v1.Schema$Filter[],
  plannedCreates?: Array<{
    senders: string[];
    query: string;
    addLabelIds: string[];
    removeLabelIds: string[];
    alreadyExists: boolean;
  }>,
): Promise<Result<MigrationResult>> {
  const errors: string[] = [];
  let filtersCreated = 0;
  let filtersDeleted = 0;

  let plan = existingPlan;
  if (plan === null) {
    if (staleKeptFilters === undefined || perSenderFilters === undefined || plannedCreates === undefined) {
      return { ok: false, error: "Delete-first migration snapshot is missing required planning inputs." };
    }
    plan = buildDeleteFirstPlan(
      noiseLabelId,
      staleKeptFilters,
      perSenderFilters,
      plannedCreates.map((planned) => ({
        senders: planned.senders,
        query: planned.query,
        removeLabelIds: planned.removeLabelIds,
      })),
    );

    // Persist before any mutation
    await writeDeleteFirstPlan(snapshotPath, plan);
  }

  // Resume must stay consistent with the frozen snapshot even if the current
  // _noise label has since been recreated with a different Gmail ID.
  const effectiveNoiseLabelId = plan.noiseLabelId;

  // Step 2: Delete all remaining snapshot delete targets
  const remainingDeletes = getRemainingDeleteTargets(existingFilters, plan);

  for (const target of remainingDeletes) {

    try {
      const deleteResult = await client.deleteFilter(target.filterId);
      if (!deleteResult.ok) {
        // Treat "not found" style errors as already deleted
        if (
          deleteResult.error.includes("404") ||
          deleteResult.error.includes("not found") ||
          deleteResult.error.includes("Not Found")
        ) {
          continue;
        }
        errors.push(`Failed to delete filter ${target.filterId}: ${deleteResult.error}`);
      } else {
        filtersDeleted++;
      }
    } catch (err: unknown) {
      errors.push(`deleteFilter threw for ${target.filterId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: Refresh Gmail filters after deletes
  const refreshResult = await client.listFilters();
  if (!refreshResult.ok) {
    return { ok: false, error: `Failed to refresh filters after deletes: ${refreshResult.error}` };
  }
  const filtersAfterDeletes = refreshResult.value;

  // Step 4: Recompute actual headroom for creates
  const remainingCreates = getRemainingCreateTargets(filtersAfterDeletes, effectiveNoiseLabelId, plan);
  const actualHeadroom = MAX_GMAIL_FILTERS - filtersAfterDeletes.length;
  if (remainingCreates.length > actualHeadroom) {
    return {
      ok: false,
      error: `Not enough headroom after delete-first: ${filtersAfterDeletes.length} filters remain, ${remainingCreates.length} consolidated filters needed, ${actualHeadroom} slots available. Snapshot preserved at ${snapshotPath} for retry.`,
    };
  }

  // Step 5: Create remaining consolidated filters
  let createFailed = false;
  for (const target of remainingCreates) {
    try {
      const createResult = await client.createFilter(
        { query: target.query },
        { addLabelIds: [effectiveNoiseLabelId], removeLabelIds: target.removeLabelIds },
      );

      if (!createResult.ok) {
        errors.push(`Failed to create consolidated filter: ${createResult.error}`);
        createFailed = true;
      } else {
        filtersCreated++;
      }
    } catch (err: unknown) {
      errors.push(`createFilter threw: ${err instanceof Error ? err.message : String(err)}`);
      createFailed = true;
    }
  }

  if (createFailed) {
    return {
      ok: false,
      error: `Delete-first migration incomplete — ${errors.length} create error(s). Snapshot preserved at ${snapshotPath} for retry. Errors: ${errors.join("; ")}`,
    };
  }

  // Step 6: Verify against live Gmail that all targets are satisfied
  const verifyResult = await client.listFilters();
  if (!verifyResult.ok) {
    return { ok: false, error: `Failed to verify filters after creates: ${verifyResult.error}` };
  }
  const finalFilters = verifyResult.value;
  const finalFilterIds = new Set(
    finalFilters.map((filter) => filter.id).filter((filterId): filterId is string => typeof filterId === "string"),
  );

  // Check no delete targets still exist
  for (const target of plan.deleteTargets) {
    if (finalFilterIds.has(target.filterId)) {
      return {
        ok: false,
        error: `Delete-first migration incomplete — delete target ${target.filterId} still exists in Gmail. Snapshot preserved at ${snapshotPath} for retry.`,
      };
    }
  }

  // Check all create targets are satisfied
  for (const target of plan.createTargets) {
    if (!hasEquivalentConsolidatedFilter(finalFilters, target.query, effectiveNoiseLabelId, target.removeLabelIds)) {
      return {
        ok: false,
        error: `Delete-first migration incomplete — consolidated filter for query "${target.query.substring(0, 60)}..." not found in Gmail. Snapshot preserved at ${snapshotPath} for retry.`,
      };
    }
  }

  // Step 7: All targets satisfied — clean up snapshot
  await deleteDeleteFirstPlan(snapshotPath);

  return {
    ok: true,
    value: {
      filtersCreated,
      filtersDeleted,
      slotsFreed: filtersDeleted - filtersCreated,
      errors,
    },
  };
}
