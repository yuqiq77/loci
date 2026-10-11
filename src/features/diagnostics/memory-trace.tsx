"use client";

import type { MemoryTraceDecision } from "@/server/db/diagnostics";

import { SessionLink } from "./session-link";
import { formatStamp, useLoad } from "./use-load";

type TraceResponse = { memoryId: string; decisions: MemoryTraceDecision[] };

// The trace drawer over /api/memories/:id/trace (MC-123 §2.5). An empty
// trace means no decision was recorded within the trace margin — not that
// the memory was never considered (that answer needs MC-200's dry-run).
export function MemoryTrace({ memoryId }: { memoryId: string }) {
  const { data, error, loading } = useLoad<TraceResponse>(
    `/api/memories/${memoryId}/trace`,
  );

  if (loading) {
    return <p className="mt-3 text-xs text-stone-400">Loading trace...</p>;
  }
  if (error || !data) {
    return (
      <p className="mt-3 text-xs text-red-700" role="alert">
        Unable to load the trace.
      </p>
    );
  }
  if (data.decisions.length === 0) {
    return (
      <p className="mt-3 rounded-lg bg-stone-50 p-3 text-xs text-stone-500">
        No injection decisions recorded within the trace margin.
      </p>
    );
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-lg bg-stone-50 p-3">
      <table className="w-full text-left text-xs">
        <thead className="text-stone-400">
          <tr>
            <th className="pr-3 font-medium">When</th>
            <th className="pr-3 font-medium">Decision</th>
            <th className="pr-3 font-medium">Similarity</th>
            <th className="pr-3 font-medium">Score</th>
            <th className="font-medium">Session</th>
          </tr>
        </thead>
        <tbody className="text-stone-700">
          {data.decisions.map((decision) => (
            <tr key={decision.id}>
              <td className="pr-3 py-1 whitespace-nowrap">
                {formatStamp(decision.createdAt)}
              </td>
              <td className="pr-3 py-1">
                {decision.injected
                  ? "injected"
                  : `suppressed (${decision.suppressionReason ?? "unknown"})`}
              </td>
              <td className="pr-3 py-1">{decision.similarity.toFixed(3)}</td>
              <td className="pr-3 py-1">{decision.score.toFixed(3)}</td>
              <td className="py-1">
                <SessionLink sessionId={decision.sessionId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
