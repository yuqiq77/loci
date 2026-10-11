import { ToolPageHeader } from "@/components/tool-page-header";
import { MemoryList } from "@/features/memories/memory-list";

export default function MemoriesPage() {
  return (
    <main className="min-h-screen bg-surface-panel text-stone-900">
      <div className="mx-auto max-w-4xl px-4 py-8 pb-24 sm:px-6">
        <ToolPageHeader page="memories" />
        <MemoryList />
      </div>
    </main>
  );
}
