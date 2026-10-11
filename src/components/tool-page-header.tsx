import Link from "next/link";

import { ArrowLeftIcon } from "@/components/icons";

export const TOOL_PAGE_COPY = {
  settings: {
    title: "Settings",
    description: "Configure the system prompt, token budgets, and tools.",
  },
  memories: {
    title: "Memories",
    description:
      "Search and curate long-term memories: durable facts, shifts, open threads, and notable moments.",
  },
  profile: {
    title: "Profile",
    description: "Manage the standing context used across conversations.",
  },
  journals: {
    title: "Journals",
    description: "Daily entries written from each day's conversations.",
  },
  diagnostics: {
    title: "Diagnostics",
    description:
      "Memory, background jobs, and recorded tool activity. Token figures are the local estimator.",
  },
} as const;

export type ToolPageKey = keyof typeof TOOL_PAGE_COPY;

const BACK_CLASS =
  "group flex w-fit items-center gap-1.5 text-[13px] font-medium text-stone-500 transition-colors hover:text-stone-900";

export function ToolPageHeader({
  page,
  backHref,
  onBack,
}: {
  page: ToolPageKey;
  backHref?: string;
  onBack?: () => void;
}) {
  const copy = TOOL_PAGE_COPY[page];
  const backLabel = (
    <>
      <ArrowLeftIcon className="size-4 transition-transform group-hover:-translate-x-0.5" />
      <span>Back to chats</span>
    </>
  );

  return (
    <header>
      {onBack ? (
        <button className={BACK_CLASS} onClick={onBack} type="button">
          {backLabel}
        </button>
      ) : (
        <Link className={BACK_CLASS} href={backHref ?? "/"}>
          {backLabel}
        </Link>
      )}
      <div className="mb-8 mt-5">
        <h1 className="text-[32px] font-bold leading-none text-stone-900">
          {copy.title}
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          {copy.description}
        </p>
      </div>
    </header>
  );
}
