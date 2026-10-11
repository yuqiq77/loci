import { ToolPageHeader } from "@/components/tool-page-header";
import { ProfileEditor } from "@/features/profile/profile-editor";

export default function ProfilePage() {
  return (
    <main className="min-h-screen bg-surface-panel text-stone-900">
      <div className="mx-auto max-w-4xl px-4 py-8 pb-24 sm:px-6">
        <ToolPageHeader page="profile" />
        <ProfileEditor />
      </div>
    </main>
  );
}
