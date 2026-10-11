import type { SettingsInput } from "@/server/settings/schema";

export type SettingsResponse = {
  settings: SettingsInput & { updatedAt: string };
  models: Array<{ id: string; label: string }>;
  defaultModelId: string;
  memoryEnabled: boolean;
};
