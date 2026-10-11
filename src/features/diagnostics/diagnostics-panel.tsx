"use client";

import { useState } from "react";

import type {
  DiagnosticsPulse,
  FenceRow,
  FenceView,
  JobStatus,
  JobType,
  JobView,
  SectionResult,
  ToolRunAttemptView,
  ToolRunView,
} from "@/server/db/diagnostics";
import type { DecodedJobError } from "@/server/jobs/last-error";
import { JOB_TYPES } from "@/shared/jobs";

import { SessionLink } from "./session-link";
import { formatStamp, useLoad } from "./use-load";

const JOB_LABELS: Record<JobType, string> = {
  update_recent_snapshot: "Recent snapshot",
  consolidate_narrative: "Narrative",
  write_diary_entry: "Journal",
  extract_memories: "Memory extraction",
  summarize_session: "Session summary",
  embed_memory: "Embedding",
  title_session: "Title",
};

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "Pending",
  running: "Running",
  failed: "Failed",
  complete: "Complete",
};
const STATUS_ORDER: JobStatus[] = ["pending", "running", "failed", "complete"];

const CARD_CLASS =
  "rounded-3xl border border-stone-200/50 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.01)]";
const GROUP_TITLE_CLASS = "text-sm font-semibold text-stone-700";
const TABLE_HEAD_CLASS = "text-left text-stone-400";
const SELECT_CLASS =
  "rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition focus:border-stone-400";
const MONO_BLOCK_CLASS =
  "mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-700";
const BUTTON_CLASS =
  "rounded-xl border border-stone-200 bg-white px-4 py-2 text-xs font-semibold text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60";

function jobLabel(type: string): string {
  return (JOB_LABELS as Record<string, string>)[type] ?? type;
}

function chipClass(active: boolean): string {
  return `rounded-full border px-3 py-1 text-xs font-semibold transition ${
    active
      ? "border-stone-800 bg-stone-800 text-white"
      : "border-stone-200 text-stone-600 hover:bg-stone-50"
  }`;
}

function isSectionError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    Object.keys(value).length === 1
  );
}

// Same-day rows show the time; older rows the date (the year only when it
// differs).
function formatCreated(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return formatStamp(iso).slice(11);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={CARD_CLASS}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-stone-500">
          {title}
        </h2>
        {summary ? <p className="text-xs text-stone-400">{summary}</p> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SectionError({ code }: { code: string }) {
  return (
    <p className="text-sm text-red-700" role="alert">
      Section failed: <span className="font-mono">{code}</span>
    </p>
  );
}

function Loading() {
  return <p className="text-sm text-stone-400">Loading...</p>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-stone-50 px-3 py-2">
      <dt className="text-[11px] text-stone-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-stone-800">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  const tone =
    status === "failed"
      ? "text-red-700"
      : status === "running"
        ? "text-amber-700"
        : status === "pending"
          ? "text-stone-500"
          : "text-stone-800";
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function CountList({ items }: { items: { label: string; count: number }[] }) {
  if (items.length === 0) {
    return <p className="mt-2 text-xs text-stone-400">none</p>;
  }
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
      {items.map((item) => (
        <li key={item.label}>
          <span className="font-mono">{item.label}</span> {item.count}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Pulse

function CarriersTable({
  carriers,
}: {
  carriers: Exclude<DiagnosticsPulse["carriers"], { error: string }>;
}) {
  const { narrative, recentSnapshot, diary } = carriers;
  const rows: {
    carrier: string;
    version: string;
    tokens: string;
    updated: string;
    note: string;
  }[] = [
    {
      carrier: "Narrative",
      version: narrative ? `v${narrative.version}` : "none",
      tokens: narrative ? `${narrative.estimatedTokens} est` : "—",
      updated: narrative ? formatStamp(narrative.updatedAt) : "—",
      note: narrative
        ? `watermark ${formatStamp(narrative.consolidatedThrough)}`
        : "",
    },
    {
      carrier: "Recent snapshot",
      version: recentSnapshot ? `v${recentSnapshot.version}` : "none",
      tokens: recentSnapshot ? `${recentSnapshot.estimatedTokens} est` : "—",
      updated: recentSnapshot ? formatStamp(recentSnapshot.asOf) : "—",
      note: recentSnapshot
        ? `as of · ${Math.round(recentSnapshot.ageMinutes / 60)} h ago`
        : "",
    },
    {
      carrier: "Journal",
      version: `${diary.entries} ${diary.entries === 1 ? "entry" : "entries"}`,
      tokens: "—",
      updated: diary.lastEntryDate ?? "—",
      note: [
        diary.epoch ? `epoch ${formatStamp(diary.epoch).slice(0, 10)}` : null,
        diary.lastJob
          ? `last job ${diary.lastJob.date ?? "?"} · ${STATUS_LABELS[diary.lastJob.status]}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead className={TABLE_HEAD_CLASS}>
          <tr>
            <th className="pb-1 pr-3 font-medium">Carrier</th>
            <th className="pb-1 pr-3 font-medium">Version</th>
            <th className="pb-1 pr-3 font-medium">Tokens (est)</th>
            <th className="pb-1 pr-3 font-medium">Updated</th>
            <th className="pb-1 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="text-stone-700">
          {rows.map((row) => (
            <tr className="border-t border-stone-100" key={row.carrier}>
              <td className="py-2 pr-3 font-semibold text-stone-800">{row.carrier}</td>
              <td className="py-2 pr-3">{row.version}</td>
              <td className="py-2 pr-3">{row.tokens}</td>
              <td className="py-2 pr-3 whitespace-nowrap">{row.updated}</td>
              <td className="py-2 text-stone-500">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PulseSection({
  pulse,
}: {
  pulse: ReturnType<typeof useLoad<DiagnosticsPulse>>;
}) {
  const { data, error, loading, stale } = pulse;
  return (
    <Section title="Pulse">
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <SectionError code="fetch" />
      ) : (
        <div className={`space-y-6 ${stale ? "opacity-50" : ""}`}>
          {isSectionError(data.memories) ? (
            <SectionError code={data.memories.error} />
          ) : (
            <div>
              <h3 className={GROUP_TITLE_CLASS}>Memories</h3>
              <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Active" value={data.memories.active} />
                <Stat label="Trash" value={data.memories.trash} />
                <Stat label="Pinned" value={data.memories.pinned} />
                <Stat
                  label="Open threads unresolved"
                  value={data.memories.unresolvedOpenThreads}
                />
                <Stat
                  label="Missing embedding"
                  value={data.memories.missingEmbedding}
                />
                <Stat
                  label="Superseded (active)"
                  value={data.memories.superseded}
                />
                <Stat label="Chain heads" value={data.memories.chainHeads} />
                <Stat
                  label="Duplicate groups"
                  value={`${data.memories.duplicateGroups} (largest ${data.memories.largestDuplicateGroup})`}
                />
              </dl>
              <CountList
                items={data.memories.byKind.map((row) => ({
                  label: row.kind,
                  count: row.count,
                }))}
              />
            </div>
          )}
          {isSectionError(data.injections) ? (
            <SectionError code={data.injections.error} />
          ) : (
            <div>
              <h3 className={GROUP_TITLE_CLASS}>
                Injections since {data.injections.sinceDay}
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Injected" value={data.injections.injected} />
                <Stat label="Suppressed" value={data.injections.suppressed} />
                <Stat
                  label="Assistant turns"
                  value={data.injections.assistantTurns.total}
                />
                <Stat
                  label="With web search"
                  value={data.injections.assistantTurns.withWebSearch}
                />
              </dl>
              <CountList
                items={data.injections.suppressedByReason.map((row) => ({
                  label: row.reason,
                  count: row.count,
                }))}
              />
              {data.injections.topMemories.length > 0 ? (
                <ol className="mt-3 space-y-1 text-xs text-stone-600">
                  {data.injections.topMemories.map((row) => (
                    <li className="flex gap-2" key={row.memoryId}>
                      <span className="w-6 shrink-0 text-right font-semibold text-stone-800">
                        {row.count}
                      </span>
                      <span className="font-mono text-stone-400" title={row.memoryId}>
                        {row.memoryId.slice(0, 8)}
                      </span>
                      <span className="text-stone-500">{row.kind}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          )}
          {isSectionError(data.carriers) ? (
            <SectionError code={data.carriers.error} />
          ) : (
            <div>
              <h3 className={GROUP_TITLE_CLASS}>Continuity carriers</h3>
              <CarriersTable carriers={data.carriers} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Fences + queue (one endpoint)

type JobsResponse = {
  listing: SectionResult<{ rows: JobView[]; nextCursor: string | null }>;
  // First page only; later pages continue the listing.
  fences?: SectionResult<FenceView[]>;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-stone-400">{label}</p>
      <div className="mt-1 text-xs text-stone-700">{children}</div>
    </div>
  );
}

function ErrorGroup({ decoded }: { decoded: DecodedJobError }) {
  const { record } = decoded;
  return (
    <div>
      <p className={GROUP_TITLE_CLASS}>Error</p>
      {record ? (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Stage" value={record.stage} />
            <Stat label="Model" value={record.model ?? "—"} />
            <Stat
              label="Finish reason"
              value={record.finishReason ?? "—"}
            />
            <Stat label="Cap" value={record.cap ?? "—"} />
            <Stat label="Output tokens" value={record.outputTokens ?? "—"} />
            <Stat label="Output chars" value={record.outputChars} />
          </dl>
          <p className="mt-3 text-[11px] text-stone-400">
            Excerpt
            {decoded.records > 1
              ? ` · first of ${decoded.records} candidates`
              : ""}
            {decoded.partial ? " · partial record" : ""}
          </p>
          <blockquote className="mt-1.5 whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50/60 p-3 font-mono text-[11px] leading-relaxed text-stone-600">
            {record.excerpt || "(no excerpt)"}
          </blockquote>
        </>
      ) : decoded.partial ? (
        <p className="mt-2 text-[11px] font-semibold text-amber-700">partial record</p>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-stone-500">
          raw error
        </summary>
        <pre className={MONO_BLOCK_CLASS}>{decoded.raw}</pre>
      </details>
    </div>
  );
}

function JobDetails({ job }: { job: JobView }) {
  const entries = Object.entries(job.payload);
  return (
    <div className="space-y-4 text-xs">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Available" value={formatStamp(job.availableAt)} />
        <Stat label="Locked" value={formatStamp(job.lockedAt)} />
        <Stat label="Completed" value={formatStamp(job.completedAt)} />
        <Stat
          label="Policy"
          value={job.policyVersion === null ? "manual" : `v${job.policyVersion}`}
        />
      </dl>
      {entries.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {entries.map(([key, value]) => (
            <Field key={key} label={key}>
              {key === "sessionId" && typeof value === "string" ? (
                <SessionLink sessionId={value} />
              ) : (
                <span className="font-mono text-xs">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              )}
            </Field>
          ))}
        </div>
      ) : null}
      {job.sourceKey ? (
        <Field label="Source key">
          <span className="break-all font-mono text-xs">{job.sourceKey}</span>
        </Field>
      ) : null}
      {job.exhausted.length > 0 ? (
        <div>
          <p className={GROUP_TITLE_CLASS}>Exhausted candidates</p>
          <ul className="mt-2 space-y-1 font-mono text-[11px] text-stone-600">
            {job.exhausted.map((candidate, index) => (
              <li key={index}>
                {candidate.stage} · {candidate.model} @ {candidate.baseUrl} ·{" "}
                {candidate.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {job.lastError ? <ErrorGroup decoded={job.lastError} /> : null}
      <p className="font-mono text-[11px] text-stone-400">{job.id}</p>
    </div>
  );
}

function JobRow({ job }: { job: JobView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-stone-100 hover:bg-stone-50"
        onClick={() => setOpen((value) => !value)}
      >
        <td className="py-2 pr-3 font-semibold text-stone-800">
          <span className="inline-flex items-center gap-2">
            <span
              className={`text-stone-400 transition-transform ${open ? "rotate-90" : ""}`}
            >
              ›
            </span>
            {jobLabel(job.type)}
          </span>
        </td>
        <td className="py-2 pr-3 whitespace-nowrap">{formatCreated(job.createdAt)}</td>
        <td className="py-2 pr-3">
          <StatusBadge status={job.status} />
        </td>
        <td className="py-2 pr-3">{job.attempts}</td>
        <td className="py-2">
          {job.sourceKey ? `auto p${job.policyVersion ?? "?"}` : "manual"}
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-stone-100 bg-stone-50/60">
          <td className="px-3 py-4" colSpan={5}>
            <JobDetails job={job} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FenceRowView({ row, kind }: { row: FenceRow; kind: "blocking" | "history" }) {
  return (
    <li className="text-xs text-stone-600">
      <span className="font-mono text-[11px] text-stone-400">{row.id.slice(0, 8)}</span>{" "}
      {kind === "history" ? `history (policy v${row.policyVersion ?? "?"}) · ` : ""}
      {row.attempts} {row.attempts === 1 ? "attempt" : "attempts"} ·{" "}
      {formatStamp(row.completedAt)}
      {row.lastError ? (
        <span className="text-stone-500">
          {" "}
          · {row.lastError.raw.split("\n")[0].slice(0, 100)}
        </span>
      ) : null}
    </li>
  );
}

function FenceStrip({ fence }: { fence: FenceView }) {
  return (
    <div className="rounded-xl border border-stone-100 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-stone-800">{fence.label}</p>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            fence.status === "blocked"
              ? "bg-red-100 text-red-700"
              : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {fence.status}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-stone-400">
        policy v{fence.policyVersion} ·{" "}
        {fence.sourceKey ? (
          <span
            className="cursor-copy break-all font-mono"
            onClick={() => void navigator.clipboard?.writeText(fence.sourceKey!)}
            title="click to copy"
          >
            {fence.sourceKey}
          </span>
        ) : (
          "no source key"
        )}
      </p>
      {fence.blockedBy ? (
        <ul className="mt-2">
          <FenceRowView kind="blocking" row={fence.blockedBy} />
        </ul>
      ) : null}
      {fence.history.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {fence.history.map((row) => (
            <FenceRowView key={row.id} kind="history" row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function queueSummary(queue: DiagnosticsPulse["queue"] | undefined) {
  if (!queue || isSectionError(queue)) {
    return null;
  }
  const pending = queue.byStatusType
    .filter((row) => row.status === "pending")
    .reduce((sum, row) => sum + row.count, 0);
  const failed = queue.failedByType.reduce((sum, row) => sum + row.count, 0);
  return `${pending} pending · ${queue.running.length} running · ${failed} failed in 7 days`;
}

const QUEUE_PAGE_SIZE = 25;

function FencesAndQueue({
  generation,
  queue,
}: {
  generation: number;
  queue: DiagnosticsPulse["queue"] | undefined;
}) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [type, setType] = useState<JobType | "">("");
  // Pages after the first are a stack of cursors (the last row id of each
  // previous page), keyed to the filters and the refresh generation so a
  // change of either starts over at page 1.
  const filterKey = `${status ?? ""}|${type}#${generation}`;
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [];
  const params = new URLSearchParams({ limit: String(QUEUE_PAGE_SIZE) });
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  const before = cursors[cursors.length - 1];
  if (before) params.set("before", before);
  const { data, error, loading, stale } = useLoad<JobsResponse>(
    `/api/diagnostics/jobs?${params}`,
    generation,
  );
  const listing = data && !isSectionError(data.listing) ? data.listing : null;
  const rows = listing?.rows ?? [];
  // Fences ride along with page 1 only; later pages keep what page 1 gave.
  const [seenFences, setSeenFences] = useState<{
    generation: number;
    fences: SectionResult<FenceView[]>;
  } | null>(null);
  if (data?.fences && seenFences?.fences !== data.fences) {
    setSeenFences({ generation, fences: data.fences });
  }
  const fenceResult =
    data?.fences ??
    (seenFences?.generation === generation ? seenFences.fences : undefined);
  const fences = fenceResult && !isSectionError(fenceResult) ? fenceResult : null;
  const blocked = fences?.filter((fence) => fence.status === "blocked").length ?? 0;
  const oldestPending =
    queue && !isSectionError(queue) ? queue.oldestPendingAvailableAt : null;

  function goNext() {
    if (listing?.nextCursor) {
      setPaging({ key: filterKey, cursors: [...cursors, listing.nextCursor] });
    }
  }
  function goPrev() {
    setPaging({ key: filterKey, cursors: cursors.slice(0, -1) });
  }

  return (
    <>
      <Section
        title="Fences"
        summary={fences ? (blocked > 0 ? `${blocked} blocked` : "all clear") : null}
      >
        {loading && !fenceResult ? (
          <Loading />
        ) : !fenceResult ? (
          <SectionError code="fetch" />
        ) : isSectionError(fenceResult) ? (
          <SectionError code={fenceResult.error} />
        ) : (
          <div className="space-y-2">
            {fenceResult.map((fence, index) => (
              <FenceStrip fence={fence} key={`${fence.jobType}-${index}`} />
            ))}
          </div>
        )}
      </Section>
      <Section title="Queue" summary={queueSummary(queue)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            <button className={chipClass(status === null)} onClick={() => setStatus(null)} type="button">
              All
            </button>
            {STATUS_ORDER.map((value) => (
              <button className={chipClass(status === value)} key={value} onClick={() => setStatus(value)} type="button">
                {STATUS_LABELS[value]}
              </button>
            ))}
          </div>
          <select
            aria-label="Job type"
            className={SELECT_CLASS}
            onChange={(event) => setType(event.target.value as JobType | "")}
            value={type}
          >
            <option value="">All job types</option>
            {JOB_TYPES.map((value) => (
              <option key={value} value={value}>
                {JOB_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4">
          {loading && !data ? (
            <Loading />
          ) : error || !data ? (
            <SectionError code="fetch" />
          ) : isSectionError(data.listing) ? (
            <SectionError code={data.listing.error} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-stone-400">No jobs match.</p>
          ) : (
            <div
              className={`overflow-x-auto transition-opacity ${stale ? "opacity-50" : ""}`}
            >
              <table className="w-full text-xs">
                <thead className={TABLE_HEAD_CLASS}>
                  <tr>
                    <th className="pb-1 pr-3 font-medium">Job</th>
                    <th className="pb-1 pr-3 font-medium">Created</th>
                    <th className="pb-1 pr-3 font-medium">Status</th>
                    <th className="pb-1 pr-3 font-medium">Attempts</th>
                    <th className="pb-1 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="text-stone-700">
                  {rows.map((job) => (
                    <JobRow job={job} key={job.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-stone-400">
            <span>
              page {cursors.length + 1} · {rows.length}{" "}
              {rows.length === 1 ? "job" : "jobs"}
              <span className="ml-3 inline-flex gap-2">
                <button
                  className="font-semibold text-stone-500 transition hover:text-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={cursors.length === 0 || loading}
                  onClick={goPrev}
                  type="button"
                >
                  prev
                </button>
                <button
                  className="font-semibold text-stone-500 transition hover:text-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!listing?.nextCursor || loading}
                  onClick={goNext}
                  type="button"
                >
                  next
                </button>
              </span>
            </span>
            <span>Oldest pending · {formatStamp(oldestPending)}</span>
          </div>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tool runs

type SessionsResponse = {
  sessions: { id: string; title: string; updatedAt: string }[];
};

function ToolRunRow({ run }: { run: ToolRunView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-stone-100 hover:bg-stone-50"
        onClick={() => setOpen((value) => !value)}
      >
        <td className="py-1.5 pr-3 font-mono">
          {run.roundIndex}.{run.callIndex}
        </td>
        <td className="py-1.5 pr-3 font-mono">{run.toolName}</td>
        <td className="py-1.5 pr-3">{run.status}</td>
        <td className="py-1.5 pr-3">
          {run.isError ? (
            <span className="font-semibold text-red-700">
              error {run.errorCode ?? ""}
            </span>
          ) : (
            "ok"
          )}
        </td>
        <td className="py-1.5 pr-3">
          {run.elapsedMs === null ? "—" : `${run.elapsedMs} ms`}
        </td>
        <td className="py-1.5 text-stone-500">
          {run.purgedAt ? `purged ${formatStamp(run.purgedAt)}` : ""}
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-stone-100 bg-stone-50/60">
          <td className="px-3 py-3" colSpan={6}>
            <div className="space-y-3 text-xs">
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Started" value={formatStamp(run.startedAt)} />
                <Stat label="Finished" value={formatStamp(run.finishedAt)} />
                <Stat
                  label="Schema"
                  value={
                    <span className="break-all font-mono text-xs">
                      {run.toolSchemaHash ?? "—"}
                    </span>
                  }
                />
              </dl>
              {run.precedingText ? (
                <Field label="Preceding text">
                  <pre className={MONO_BLOCK_CLASS}>{run.precedingText}</pre>
                </Field>
              ) : null}
              <Field label="Input">
                <pre className={MONO_BLOCK_CLASS}>
                  {run.purgedAt && run.input === null
                    ? `purged ${formatStamp(run.purgedAt)}`
                    : JSON.stringify(run.input, null, 2)}
                </pre>
              </Field>
              <Field label="Result">
                <pre className={MONO_BLOCK_CLASS}>
                  {run.purgedAt
                    ? `purged ${formatStamp(run.purgedAt)}`
                    : (run.resultContent ?? "(no result recorded)")}
                </pre>
              </Field>
              <p className="font-mono text-[11px] text-stone-400">{run.id}</p>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ToolRunsSection({ generation }: { generation: number }) {
  const [sessionId, setSessionId] = useState<string>("");
  // The conversation list is not what Refresh is for; only the runs reload.
  const sessions = useLoad<SessionsResponse>("/api/sessions");
  const runs = useLoad<{ attempts: ToolRunAttemptView[] }>(
    sessionId ? `/api/diagnostics/tool-runs?sessionId=${sessionId}` : null,
    generation,
  );
  const attempts = runs.data?.attempts ?? [];
  return (
    <Section
      title="Tool runs"
      summary={
        sessionId && runs.data
          ? `${attempts.length} ${attempts.length === 1 ? "attempt" : "attempts"}`
          : null
      }
    >
      <select
        aria-label="Conversation"
        className={`${SELECT_CLASS} w-full`}
        onChange={(event) => setSessionId(event.target.value)}
        value={sessionId}
      >
        <option value="">Choose a conversation…</option>
        {(sessions.data?.sessions ?? []).map((session) => (
          <option key={session.id} value={session.id}>
            {session.title} · {formatStamp(session.updatedAt)}
          </option>
        ))}
      </select>
      <div className="mt-4">
        {!sessionId ? null : runs.loading ? (
          <Loading />
        ) : runs.error || !runs.data ? (
          <SectionError code="fetch" />
        ) : attempts.length === 0 ? (
          <p className="text-sm text-stone-400">
            No tool runs recorded for this conversation.
          </p>
        ) : (
          <div className="space-y-4">
            {attempts.map((attempt) => (
              <div key={attempt.attemptId}>
                <p className="font-mono text-[11px] text-stone-500">
                  attempt {attempt.attemptId.slice(0, 8)} · message{" "}
                  {attempt.assistantMessageId.slice(0, 8)} ·{" "}
                  {formatStamp(attempt.startedAt)} · {attempt.runs.length}{" "}
                  {attempt.runs.length === 1 ? "run" : "runs"}
                </p>
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className={TABLE_HEAD_CLASS}>
                      <tr>
                        <th className="pr-3 font-medium">Round.call</th>
                        <th className="pr-3 font-medium">Tool</th>
                        <th className="pr-3 font-medium">Status</th>
                        <th className="pr-3 font-medium">Outcome</th>
                        <th className="pr-3 font-medium">Elapsed</th>
                        <th className="font-medium">Body</th>
                      </tr>
                    </thead>
                    <tbody className="text-stone-700">
                      {attempt.runs.map((run) => (
                        <ToolRunRow key={run.id} run={run} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function DiagnosticsPanel() {
  // Bumping the generation re-fetches every section (manual refresh; the
  // page never polls).
  const [generation, setGeneration] = useState(0);
  const pulse = useLoad<DiagnosticsPulse>("/api/diagnostics/pulse", generation);
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          className={BUTTON_CLASS}
          onClick={() => setGeneration((value) => value + 1)}
          type="button"
        >
          Refresh
        </button>
      </div>
      <PulseSection pulse={pulse} />
      <FencesAndQueue generation={generation} queue={pulse.data?.queue} />
      <ToolRunsSection generation={generation} />
    </div>
  );
}
