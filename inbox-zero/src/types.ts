/**
 * Shared Result type used throughout the inbox-zero codebase.
 *
 * All public functions that can fail return `Result<T>` instead of throwing,
 * making error handling explicit and composable.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
