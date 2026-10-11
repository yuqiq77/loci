"use client";

import { useEffect, useState } from "react";

import { formatContextStamp } from "@/server/chat/context";

type Loaded<T> = { key: string; data: T | null; error: string | null };

// Pull-on-load; the caller's `generation` is the manual refresh (no polling,
// MC-123 §2.6). The result is keyed by the request, so "loading" is derived
// rather than set. While a new request is in flight the previous result is
// still returned (`stale: true`) so a filter or page change re-renders in
// place instead of collapsing the section to a loading line.
export function useLoad<T>(url: string | null, generation = 0) {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const key = url ? `${url}#${generation}` : null;

  useEffect(() => {
    if (!key || !url) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Request failed (${response.status}).`);
        }
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) {
          setLoaded({ key, data, error: null });
        }
      } catch (loadError) {
        if (
          !(loadError instanceof DOMException && loadError.name === "AbortError")
        ) {
          setLoaded({ key, data: null, error: "Unable to load." });
        }
      }
    })();
    return () => controller.abort();
  }, [key, url]);

  const fresh = key && loaded?.key === key ? loaded : null;
  const shown = key ? (fresh ?? loaded) : null;
  return {
    data: shown?.data ?? null,
    error: fresh?.error ?? null,
    loading: Boolean(key) && fresh === null,
    stale: Boolean(key) && fresh === null && shown !== null,
  };
}

// The transcript's own minute stamp (one clock, MC-111), so what the page
// shows lines up with what the model saw.
export function formatStamp(value: string | null): string {
  return value ? formatContextStamp(new Date(value)) : "—";
}
