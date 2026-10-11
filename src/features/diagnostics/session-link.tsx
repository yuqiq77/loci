"use client";

import {
  forgetWorkspacePanel,
  rememberLastSession,
} from "@/shared/last-session";

// The shell restores the conversation from the last-session cookie on a
// server render, so a jump is a full navigation: set the cookie, drop the
// remembered tool panel (the link may sit inside it), and load "/". A soft
// Link navigation would leave the panel open with the conversation switched
// underneath — or do nothing at all for the session already remembered.
export function SessionLink({ sessionId }: { sessionId: string }) {
  return (
    <button
      className="font-mono hover:underline"
      onClick={() => {
        rememberLastSession(sessionId);
        forgetWorkspacePanel();
        window.location.assign("/");
      }}
      title={sessionId}
      type="button"
    >
      {sessionId.slice(0, 8)}
    </button>
  );
}
