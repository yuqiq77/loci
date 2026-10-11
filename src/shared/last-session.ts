// Remembers the conversation on screen so a navigation back to "/" (tool
// pages, reloads) can restore it server-side without a blank-state flash.
// Cleared on sign-in and when the blank new-chat state is chosen.
export const LAST_SESSION_COOKIE = "loci_last_session";

export function rememberLastSession(id: string): void {
  document.cookie = `${LAST_SESSION_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
}

export function forgetLastSession(): void {
  document.cookie = `${LAST_SESSION_COOKIE}=; path=/; max-age=0`;
}

// The desktop shell's open tool panel, restored after hydration. Cleared by
// the diagnostics session links so a jump to a conversation lands on the
// chat, not on the panel that was open.
export const WORKSPACE_PANEL_STORAGE_KEY = "loci:workspace-panel";

export function forgetWorkspacePanel(): void {
  window.sessionStorage.removeItem(WORKSPACE_PANEL_STORAGE_KEY);
}
