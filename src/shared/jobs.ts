// The job vocabulary, shared by the queue (src/server/db/jobs.ts binds its
// payload schemas to JOB_TYPES), the diagnostics query schema, and the
// diagnostics panel's filter chips.
export const JOB_TYPES = [
  "update_recent_snapshot",
  "consolidate_narrative",
  "write_diary_entry",
  "extract_memories",
  "summarize_session",
  "embed_memory",
  "title_session",
] as const;

export const JOB_STATUSES = ["pending", "running", "complete", "failed"] as const;
