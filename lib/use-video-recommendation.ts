"use client";

import { useCallback, useEffect, useState } from "react";
import { recommendVideoModel, type RecommendationSettings } from "@/lib/video-recommendation";

// Every shot on a page shares the same access check. Only the pure local
// recommendation is repeated as the user types; this never starts a render.
const ACCESS_CACHE_MS = 10 * 60_000;
let cachedAccess: { at: number; ttl: number; available: Record<string, boolean> } | null = null;
let accessPromise: Promise<Record<string, boolean>> | null = null;

function loadAccess(): Promise<Record<string, boolean>> {
  if (cachedAccess && Date.now() - cachedAccess.at < cachedAccess.ttl) {
    return Promise.resolve(cachedAccess.available);
  }
  accessPromise ??= fetch("/api/video/models", {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("Model access check failed");
      const data: unknown = await response.json();
      const value = data && typeof data === "object" && "available" in data
        ? data.available
        : null;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid model access response");
      }
      const available = Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      );
      const ttl = Object.keys(available).length > 0 && Object.values(available).every(Boolean)
        ? ACCESS_CACHE_MS
        : 30_000;
      cachedAccess = { at: Date.now(), ttl, available };
      return available;
    })
    .finally(() => {
      accessPromise = null;
    });
  return accessPromise;
}

export function useVideoRecommendation(
  prompt: string,
  settings: RecommendationSettings,
  pinned = false,
  enabled = true
) {
  const [requestKey, setRequestKey] = useState(0);
  const [access, setAccess] = useState<{
    key: number;
    available: Record<string, boolean> | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // The request is shared, so unmounting one clip must not cancel another
    // clip's check. Ignore its result after cleanup; the request has a timeout.
    loadAccess().then(
      (available) => {
        if (active) setAccess({ key: requestKey, available, error: null });
      },
      () => {
        if (active) {
          setAccess({
            key: requestKey,
            available: null,
            error: "We couldn’t check available video models. Try again.",
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [enabled, requestKey]);

  const refresh = useCallback(() => {
    cachedAccess = null;
    setRequestKey((key) => key + 1);
  }, []);

  const current = enabled && access?.key === requestKey ? access : null;
  const recommendation = current?.available && prompt.trim()
    ? recommendVideoModel({ prompt, settings, available: current.available, pinned })
    : null;
  const error = enabled
    ? current?.error ?? (current?.available && prompt.trim() && !recommendation
      ? pinned
        ? "The model included in your free shot is temporarily unavailable. Try again shortly."
        : "No video models are available right now. Try again shortly."
      : null)
    : null;

  return {
    recommendation,
    loading: enabled && current === null,
    error,
    refresh,
  };
}
