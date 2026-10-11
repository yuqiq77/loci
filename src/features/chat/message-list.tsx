import type { ChatMessage } from "@/shared/types";

import { BookIcon, GlobeIcon } from "@/components/icons";

import { Markdown } from "./markdown";
import { activityLabel, WEB_SEARCH_ACTIVITY } from "./tool-status";

const STATUS_LABEL: Partial<Record<ChatMessage["status"], string>> = {
  failed: "Failed",
  cancelled: "Cancelled",
  streaming: "Streaming…",
  pending: "Pending…",
};

function tokenLabel(message: ChatMessage): string | null {
  const parts = [
    message.inputTokens === undefined ? null : `In ${message.inputTokens}`,
    message.cacheReadInputTokens === undefined
      ? null
      : `Cache read ${message.cacheReadInputTokens}`,
    message.cacheCreationInputTokens === undefined
      ? null
      : `Cache write ${message.cacheCreationInputTokens}`,
    message.outputTokens === undefined ? null : `Out ${message.outputTokens}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMessageDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function tokenTotals(messages: ChatMessage[]) {
  return messages.reduce(
    (totals, message) => ({
      input: totals.input + (message.inputTokens ?? 0),
      output: totals.output + (message.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

export function MessageList({
  messages,
  loading,
  loadError,
  editTargetId,
  retryTargetId,
  onEditTail,
  onRetryTail,
}: {
  messages: ChatMessage[];
  loading: boolean;
  loadError?: string | null;
  // Tail-rewrite affordances (MC-116B): the ids of the eligible tail user
  // and assistant message, or null when the tail is not rewritable — the
  // caller reads eligibility from the messages GET, never infers it here.
  editTargetId?: string | null;
  retryTargetId?: string | null;
  onEditTail?: () => void;
  onRetryTail?: () => void;
}) {
  if (loading) {
    return (
      <p className="mx-auto w-full max-w-4xl text-sm text-[var(--muted)]">
        Loading messages…
      </p>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-4xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        <p className="font-medium">Messages failed to load.</p>
        <p className="mt-1">{loadError}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <p className="mx-auto w-full max-w-4xl text-sm text-[var(--muted)]">
        No messages yet.
      </p>
    );
  }

  const totals = tokenTotals(messages);
  const totalTokens = totals.input + totals.output;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      {totalTokens > 0 ? (
        <div className="flex items-center gap-2 self-center rounded-full border border-stone-200/40 bg-stone-100/80 px-3.5 py-1.5 font-mono text-[11px] text-stone-600 shadow-sm backdrop-blur-md">
          <span>
            Input{" "}
            <strong className="font-bold text-stone-900">
              {formatTokenCount(totals.input)}
            </strong>
          </span>
          <span className="text-stone-300">•</span>
          <span>
            Output{" "}
            <strong className="font-bold text-stone-900">
              {formatTokenCount(totals.output)}
            </strong>
          </span>
          <span className="text-stone-300">•</span>
          <span>
            Total{" "}
            <strong className="font-bold text-stone-900">
              {formatTokenCount(totalTokens)}
            </strong>
          </span>
        </div>
      ) : null}
      {messages.map((message) => {
        const isUser = message.role === "user";
        // Transient activity only while streaming: a completed, failed, or
        // cancelled row can never show a busy indicator.
        const activeTool =
          !isUser && message.status === "streaming"
            ? (message.activeTool ?? null)
            : null;
        const label = activeTool ? null : STATUS_LABEL[message.status];
        const usage = isUser ? null : tokenLabel(message);
        const messageDate = isUser ? "" : formatMessageDate(message.createdAt);
        const showEdit = isUser && message.id === editTargetId;
        const showRetry = !isUser && message.id === retryTargetId;
        return (
          <div
            key={message.id}
            className={isUser ? "flex justify-end" : "flex justify-start"}
          >
            <div className="max-w-[82%]">
              <div
                className={`rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-[0_4px_24px_rgba(0,0,0,0.015)] md:px-5 md:py-4 ${
                  isUser
                    ? "bg-stone-200 text-stone-900 selection:bg-stone-300"
                    : "border border-stone-200/40 bg-[#f1efeb] text-stone-800"
                }`}
              >
                {!isUser && message.thinking ? (
                  <details className="group mb-3 text-stone-600">
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-full border border-white/75 bg-white/45 px-3 py-1.5 text-[11.5px] font-medium text-stone-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_2px_8px_rgba(36,33,29,0.04)] backdrop-blur-md transition hover:bg-white/65 hover:text-stone-700 [&::-webkit-details-marker]:hidden">
                      <svg
                        aria-hidden="true"
                        className="size-3 text-stone-400 transition-transform duration-200 group-open:rotate-90"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      <span>Thinking</span>
                    </summary>
                    <div
                      className="mt-2 max-h-44 overflow-y-auto border-l-2 border-stone-300/70 py-1 pl-3 pr-2 text-xs leading-relaxed text-stone-500"
                      data-thin-scroll
                    >
                      <Markdown content={message.thinking} />
                    </div>
                  </details>
                ) : null}
                {activeTool ? (
                  <div className="mb-1 flex animate-pulse items-center gap-2 text-[var(--muted)]">
                    {activeTool === WEB_SEARCH_ACTIVITY ? (
                      <GlobeIcon className="h-4 w-4" strokeWidth={1.6} />
                    ) : (
                      <BookIcon className="h-4 w-4" strokeWidth={1.6} />
                    )}
                    <span>{activityLabel(activeTool)}</span>
                  </div>
                ) : null}
                <Markdown content={message.content} />
                {label ? (
                  <p
                    className={`mt-1 text-xs ${
                      isUser ? "text-stone-500" : "text-[var(--muted)]"
                    }`}
                  >
                    {label}
                  </p>
                ) : null}
                {usage ? (
                  <p className="mt-1 text-xs text-[var(--muted)]">{usage}</p>
                ) : null}
              </div>
              {messageDate || showEdit || showRetry ? (
                <div
                  className={`mt-2 flex items-center gap-3 px-2 text-[11px] text-stone-400 ${
                    isUser ? "justify-end" : ""
                  }`}
                >
                  {messageDate ? <span>{messageDate}</span> : null}
                  {showRetry ? (
                    <button
                      className="font-medium text-stone-500 transition hover:text-stone-800"
                      onClick={onRetryTail}
                      type="button"
                    >
                      Retry
                    </button>
                  ) : null}
                  {showEdit ? (
                    <button
                      className="font-medium text-stone-500 transition hover:text-stone-800"
                      onClick={onEditTail}
                      type="button"
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
