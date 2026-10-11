import { cookies } from "next/headers";

import { ChatShell } from "@/features/chat/chat-shell";
import { AVAILABLE_MODELS } from "@/server/chat/models";
import { getSettings } from "@/server/db/settings";
import { LAST_SESSION_COOKIE } from "@/shared/last-session";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Home() {
  const [settings, cookieStore] = await Promise.all([getSettings(), cookies()]);
  const lastSession = cookieStore.get(LAST_SESSION_COOKIE)?.value;

  return (
    <ChatShell
      defaultModelId={settings.defaultModelId}
      initialSessionId={
        lastSession && SESSION_ID_PATTERN.test(lastSession)
          ? lastSession
          : null
      }
      models={AVAILABLE_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
      }))}
    />
  );
}
