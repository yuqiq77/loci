"use client";

import { FormEvent, type ReactNode, useEffect, useState } from "react";

import {
  settingsSchema,
  type SettingsInput,
} from "@/server/settings/schema";

import {
  CpuIcon,
  DatabaseIcon,
  GlobeIcon,
  InfoIcon,
  SaveIcon,
  ServerIcon,
} from "@/components/icons";
import { SwitchTrack } from "@/components/switch-track";
import type { SettingsResponse } from "./types";

type FieldErrors = Partial<Record<keyof SettingsInput, string>>;

const numericFields = [
  {
    name: "maxOutputTokens",
    label: "Maximum output tokens",
    min: 256,
    max: 16_384,
    step: 1,
  },
  {
    name: "contextTokenBudget",
    label: "Context token budget",
    min: 1,
    step: 1,
  },
  {
    name: "recentMessageBudget",
    label: "Recent message budget",
    min: 0,
    step: 1,
  },
  {
    name: "memoryTokenBudget",
    label: "Memory token budget",
    min: 0,
    max: 8000,
    step: 1,
  },
  {
    name: "capsuleTokenBudget",
    label: "Continuity capsule budget",
    min: 1500,
    max: 24_000,
    step: 1,
  },
  {
    name: "narrativeTargetTokens",
    label: "Narrative target",
    min: 500,
    max: 12_000,
    step: 1,
  },
  {
    name: "recentSnapshotTokenBudget",
    label: "Recent snapshot budget",
    min: 1,
    max: 2000,
    step: 1,
  },
  {
    name: "summaryTriggerTokens",
    label: "Summary trigger tokens",
    min: 1,
    step: 1,
  },
  {
    name: "memoryRetrievalLimit",
    label: "Memory retrieval limit",
    min: 0,
    max: 20,
    step: 1,
  },
] as const;

function fieldErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path[0] as keyof SettingsInput | undefined;
    if (field && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

// The explanatory note stays behind the info button so the row reads as a
// plain switch.
function FeatureToggle({
  checked,
  className,
  icon,
  id,
  label,
  note,
  onChange,
}: {
  checked: boolean;
  className: string;
  icon: ReactNode;
  id: string;
  label: string;
  note: string;
  onChange: (checked: boolean) => void;
}) {
  const [showNote, setShowNote] = useState(false);

  return (
    <div className={`${className} border-t border-stone-100 pt-5`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <label className="text-sm font-bold text-stone-800" htmlFor={id}>
            {label}
          </label>
          <button
            aria-controls={`${id}-note`}
            aria-expanded={showNote}
            aria-label={`About ${label.toLowerCase()}`}
            className="flex size-5 items-center justify-center rounded-full text-stone-400 transition hover:text-stone-700"
            onClick={() => setShowNote((visible) => !visible)}
            type="button"
          >
            <InfoIcon className="size-3.5" />
          </button>
        </div>
        <label className="relative inline-flex shrink-0 cursor-pointer">
          <input
            checked={checked}
            className="peer sr-only"
            id={id}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          <SwitchTrack
            className="peer-focus-visible:ring-2 peer-focus-visible:ring-stone-300 peer-focus-visible:ring-offset-2"
            on={checked}
          />
        </label>
      </div>
      <p
        className="mt-2 max-w-2xl pl-[26px] text-xs leading-relaxed text-stone-400"
        hidden={!showNote}
        id={`${id}-note`}
      >
        {note}
      </p>
    </div>
  );
}

function editableSettings(
  settings: SettingsResponse["settings"],
): SettingsInput {
  return {
    systemPrompt: settings.systemPrompt,
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    contextTokenBudget: settings.contextTokenBudget,
    recentMessageBudget: settings.recentMessageBudget,
    memoryTokenBudget: settings.memoryTokenBudget,
    capsuleTokenBudget: settings.capsuleTokenBudget,
    narrativeTargetTokens: settings.narrativeTargetTokens,
    recentSnapshotTokenBudget: settings.recentSnapshotTokenBudget,
    summaryTriggerTokens: settings.summaryTriggerTokens,
    memoryRetrievalLimit: settings.memoryRetrievalLimit,
    webSearchEnabled: settings.webSearchEnabled,
    toolsEnabled: settings.toolsEnabled,
  };
}

export function SettingsForm() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsInput | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/settings", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Unable to load settings.");
        }
        const loaded = (await response.json()) as SettingsResponse;
        if (!controller.signal.aborted) {
          setData(loaded);
          setDraft(editableSettings(loaded.settings));
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStatus("Unable to load settings.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) {
      return;
    }

    setErrors({});
    setStatus(null);
    const parsed = settingsSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      setStatus("Correct the highlighted settings.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) {
        setStatus("Unable to save settings.");
        return;
      }
      const payload = await response.json();
      setDraft(editableSettings(payload.settings));
      setStatus("Settings saved.");
    } catch {
      setStatus("Unable to save settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-[var(--muted)]">Loading settings...</p>;
  }
  if (!data || !draft) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {status ?? "Unable to load settings."}
      </p>
    );
  }

  const selectedModel =
    data.models.find((model) => model.id === data.defaultModelId)?.label ??
    data.defaultModelId;

  return (
    <form className="space-y-6" noValidate onSubmit={save}>
      <section className="rounded-3xl border border-stone-200/50 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.01)] md:p-8">
        <div className="mb-6 flex items-center gap-2.5 border-b border-stone-100 pb-4">
          <ServerIcon className="size-[18px] text-stone-500" />
          <h2 className="text-[17px] font-bold text-stone-900">
            Model &amp; Engine
          </h2>
        </div>

        <dl className="grid gap-6 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase text-stone-500">
              Default model
            </dt>
            <dd className="mt-2 text-sm font-medium text-stone-800">
              {selectedModel}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-stone-500">
              Long-term memory
            </dt>
            <dd className="mt-2 text-sm font-medium text-stone-800">
              {data.memoryEnabled ? "Enabled" : "Disabled"}
            </dd>
          </div>
        </dl>

        <p className="mt-5 text-xs leading-relaxed text-stone-400">
          Provider credentials and base URLs remain environment-only.
        </p>

        <FeatureToggle
          checked={draft.webSearchEnabled}
          className="mt-6"
          icon={<GlobeIcon className="size-4 shrink-0 text-stone-400" />}
          id="webSearchEnabled"
          label="Web search"
          note="A non-official CHAT_BASE_URL keeps web search off at the server, regardless of this toggle."
          onChange={(checked) =>
            setDraft({ ...draft, webSearchEnabled: checked })
          }
        />

        <FeatureToggle
          checked={draft.toolsEnabled}
          className="mt-5"
          icon={<DatabaseIcon className="size-4 shrink-0 text-stone-400" />}
          id="toolsEnabled"
          label="Memory search tool"
          note="Lets the model search stored memories mid-reply. Requires the embedding provider; without it the server keeps this off."
          onChange={(checked) => setDraft({ ...draft, toolsEnabled: checked })}
        />
      </section>

      <section className="rounded-3xl border border-stone-200/50 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.01)] md:p-8">
        <div className="mb-6 flex items-center gap-2.5 border-b border-stone-100 pb-4">
          <CpuIcon className="size-[18px] text-stone-500" />
          <h2 className="text-[17px] font-bold text-stone-900">
            System Prompts &amp; Budgets
          </h2>
        </div>

        <label className="block" htmlFor="systemPrompt">
          <span className="text-xs font-bold uppercase text-stone-500">
            System prompt
          </span>
          <textarea
            aria-describedby={
              errors.systemPrompt ? "systemPrompt-error" : undefined
            }
            aria-invalid={Boolean(errors.systemPrompt)}
            className="mt-2 min-h-32 w-full resize-y rounded-xl border border-stone-200 bg-stone-50/50 p-4 text-base leading-relaxed text-stone-800 outline-none transition focus:border-stone-400 md:text-sm"
            data-thin-scroll
            id="systemPrompt"
            onChange={(event) =>
              setDraft({ ...draft, systemPrompt: event.target.value })
            }
            value={draft.systemPrompt}
          />
          {errors.systemPrompt ? (
            <span
              className="mt-1 block text-sm text-red-700"
              id="systemPrompt-error"
            >
              {errors.systemPrompt}
            </span>
          ) : null}
        </label>

        <div className="mt-6 grid gap-5 font-mono sm:grid-cols-2 md:grid-cols-3">
          {numericFields.map((field) => {
            const error = errors[field.name];
            return (
              <label className="block" htmlFor={field.name} key={field.name}>
                <span className="block font-sans text-xs font-bold uppercase text-stone-500">
                  {field.label}
                </span>
                <input
                  aria-describedby={error ? `${field.name}-error` : undefined}
                  aria-invalid={Boolean(error)}
                  className="mt-2 w-full rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-2 text-base text-stone-800 outline-none transition focus:border-stone-400 md:text-sm"
                  id={field.name}
                  max={"max" in field ? field.max : undefined}
                  min={field.min}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      [field.name]: Number(event.target.value),
                    })
                  }
                  step={field.step}
                  type="number"
                  value={draft[field.name]}
                />
                {error ? (
                  <span
                    className="mt-1 block font-sans text-xs text-red-700"
                    id={`${field.name}-error`}
                  >
                    {error}
                  </span>
                ) : null}
              </label>
            );
          })}

        </div>
      </section>

      <div className="flex items-center justify-between gap-4">
        <p
          className={
            status === "Settings saved."
              ? "text-xs text-emerald-700"
              : "text-xs text-red-700"
          }
          role="status"
        >
          {status}
        </p>
        <button
          className="flex items-center gap-2 rounded-xl bg-ink px-6 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={saving}
          type="submit"
        >
          {saving ? (
            <span className="size-4 animate-spin rounded-full border-2 border-stone-500 border-t-white" />
          ) : (
            <SaveIcon className="size-4" />
          )}
          <span>{saving ? "Saving..." : "Save settings"}</span>
        </button>
      </div>
    </form>
  );
}
