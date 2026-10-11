import type { MemoryKind } from "@/shared/types";

export type { MemoryKind };

export type MemoryView = {
  id: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  valence: number;
  arousal: number;
  resolved: boolean;
  pinned: boolean;
  supersededBy: string | null;
  supersededByMemory: { id: string; content: string } | null;
  supersedes: { id: string; content: string }[];
  recallCount: number;
  lastRecalledAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
