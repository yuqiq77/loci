import { ToolPageHeader } from "@/components/tool-page-header";
import { DiaryList } from "@/features/diary/diary-list";

export default function JournalsPage() {
  return (
    <main className="min-h-screen bg-surface-panel text-stone-900">
      <div className="mx-auto max-w-4xl px-4 py-8 pb-24 sm:px-6">
        <ToolPageHeader page="journals" />
        <DiaryList />
      </div>
    </main>
  );
}
