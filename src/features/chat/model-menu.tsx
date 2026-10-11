import { useEffect, useRef, useState } from "react";

import { SwitchTrack } from "@/components/switch-track";
import type { ThinkingEffort } from "@/shared/types";

const EFFORT_OPTIONS: ThinkingEffort[] = ["low", "medium", "high", "max"];

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "claude-fable-5-1": "Most capable for the hardest tasks",
  "claude-fable-5": "Previous Fable generation",
  "claude-opus-5-5": "For complex tasks",
  "claude-opus-4-6": "Previous Opus generation",
  "claude-sonnet-4-6": "Balanced speed and quality",
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ModelMenu({
  models,
  modelId,
  thinkingEnabled,
  thinkingEffort,
  disabled,
  onModelChange,
  onThinkingChange,
  onEffortChange,
}: {
  models: { id: string; label: string }[];
  modelId: string | null;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  disabled: boolean;
  onModelChange: (modelId: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedLabel =
    models.find((model) => model.id === modelId)?.label ?? "Model";

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-10 items-center gap-1.5 rounded-full bg-stone-200 px-3 py-2 text-xs text-stone-700 transition-colors hover:bg-stone-300/70 disabled:opacity-50 sm:px-4 sm:text-sm"
        disabled={disabled || modelId === null}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="max-w-[11rem] truncate font-medium sm:max-w-none">
          {selectedLabel}
        </span>
        {thinkingEnabled ? (
          <span className="text-stone-400">
            {titleCase(thinkingEffort)}
          </span>
        ) : null}
        <svg
          aria-hidden="true"
          className={`size-3.5 text-stone-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-2xl border border-stone-200 bg-white p-1.5 shadow-lg"
          role="menu"
        >
          {models.map((model) => {
            const active = model.id === modelId;
            return (
              <button
                className={`flex w-full items-start justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-stone-100 ${
                  active ? "bg-stone-200/55" : ""
                }`}
                key={model.id}
                onClick={() => {
                  onModelChange(model.id);
                  setOpen(false);
                }}
                role="menuitemradio"
                aria-checked={active}
                type="button"
              >
                <span>
                  <span className="block text-sm font-medium">
                    {model.label}
                  </span>
                  {MODEL_DESCRIPTIONS[model.id] ? (
                    <span className="block text-xs text-stone-500">
                      {MODEL_DESCRIPTIONS[model.id]}
                    </span>
                  ) : null}
                </span>
                {active ? (
                  <span aria-hidden className="mt-0.5 text-sm">
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}

          <div className="my-1.5 border-t border-stone-200" />

          <button
            className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 transition-colors hover:bg-stone-100"
            onClick={() => onThinkingChange(!thinkingEnabled)}
            role="menuitemcheckbox"
            aria-checked={thinkingEnabled}
            type="button"
          >
            <span className="text-sm font-medium">Thinking</span>
            <SwitchTrack on={thinkingEnabled} />
          </button>

          <div className="px-3 py-2">
            <div
              className={`mb-1.5 text-sm font-medium ${
                thinkingEnabled ? "text-stone-700" : "text-stone-400"
              }`}
            >
              Effort
            </div>
            <div className="flex gap-1">
              {EFFORT_OPTIONS.map((effort) => {
                const active = effort === thinkingEffort;
                return (
                  <button
                    className={`flex-1 rounded-xl border border-transparent px-2 py-1.5 text-xs capitalize transition-colors disabled:opacity-40 ${
                      active
                        ? "bg-stone-200/55 text-stone-900"
                        : "text-stone-600 hover:bg-stone-100"
                    }`}
                    disabled={!thinkingEnabled}
                    key={effort}
                    onClick={() => onEffortChange(effort)}
                    type="button"
                  >
                    {effort}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
