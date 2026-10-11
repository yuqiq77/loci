// Model registry — the single source of truth for selectable chat models.
// `id` doubles as the Anthropic model string sent to the provider.
export const AVAILABLE_MODELS = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
  },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export function isKnownModel(id: string): boolean {
  return AVAILABLE_MODELS.some((model) => model.id === id);
}

// Allow-list of models that still accept sampling params (temperature/top_p/
// top_k). The 4.7+/5-series reject them with a 400, and every newer model
// follows that trend, so we default to NOT sending temperature and only opt in
// the known-good legacy models. New models are therefore safe without a patch.
const TEMPERATURE_MODELS = new Set<string>([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
]);

export function modelSupportsTemperature(id: string): boolean {
  return TEMPERATURE_MODELS.has(id);
}

// Models whose thinking is always on. Sending `thinking: {type: "disabled"}`
// to these returns a 400 — omit the thinking param instead when the user
// turns thinking off.
const THINKING_ALWAYS_ON_MODELS = new Set<string>([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
]);

export function modelRequiresThinking(id: string): boolean {
  return THINKING_ALWAYS_ON_MODELS.has(id);
}
