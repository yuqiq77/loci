import { FormEvent, KeyboardEvent } from "react";

import type { ThinkingEffort } from "@/shared/types";

import { ModelMenu } from "./model-menu";

export function Composer({
  centered = false,
  content,
  disabled,
  hasMessages,
  models,
  modelId,
  thinkingEnabled,
  thinkingEffort,
  onContentChange,
  onModelChange,
  onThinkingChange,
  onEffortChange,
  onSend,
}: {
  centered?: boolean;
  content: string;
  disabled: boolean;
  hasMessages: boolean;
  models: { id: string; label: string }[];
  modelId: string | null;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  onContentChange: (content: string) => void;
  onModelChange: (modelId: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
  onSend: (content: string) => Promise<void>;
}) {
  async function submit() {
    const value = content.trim();
    if (!value || disabled) {
      return;
    }
    onContentChange("");
    await onSend(value);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form
      className={
        centered
          ? "w-full"
          : "absolute inset-x-0 bottom-0 z-10 px-4 pb-4 pt-2 md:px-6 md:pb-5 md:pt-2"
      }
      onSubmit={handleSubmit}
    >
      <div className="mx-auto w-full max-w-4xl">
        <div
          className="rounded-[1.75rem] border border-white/[0.86] p-3 shadow-[0_18px_50px_rgba(36,33,29,0.12),inset_0_1px_0_rgba(255,255,255,0.92)] transition-all duration-300 focus-within:border-white focus-within:ring-2 focus-within:ring-white/70"
          data-chat-composer
        >
          <textarea
            aria-label="Message Loci"
            className="min-h-12 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-base text-stone-800 outline-none placeholder:text-stone-400 md:text-sm"
            data-no-focus-outline
            disabled={disabled}
            onChange={(event) => onContentChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              hasMessages ? "Write a reply" : "Write a message"
            }
            rows={2}
            value={content}
          />
          <div className="mt-1 flex items-center justify-between gap-3">
            <ModelMenu
              disabled={disabled}
              models={models}
              modelId={modelId}
              thinkingEffort={thinkingEffort}
              thinkingEnabled={thinkingEnabled}
              onEffortChange={onEffortChange}
              onModelChange={onModelChange}
              onThinkingChange={onThinkingChange}
            />
            <button
              aria-label="Send"
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all duration-200 disabled:cursor-not-allowed ${
                content.trim() && !disabled
                  ? "text-stone-800 active:scale-95"
                  : "text-stone-400"
              }`}
              data-glass-button
              disabled={disabled || !content.trim()}
              type="submit"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
