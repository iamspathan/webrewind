import { useEffect, useRef, useState } from "react";

/**
 * Lazily fetches an AI caption for a single snapshot. Lives inside
 * MilestoneCard so captions only start loading as the user scrolls a
 * card into view (see `enabled` — InteractiveTimeline only flips it
 * true once IntersectionObserver first sees the card).
 *
 * The server persists every successful summary into the cache manifest,
 * so `initialSummary` reflects anything already cached — when it's a
 * non-empty string we skip the fetch entirely.
 *
 * Lifecycle rules:
 *   - `enabled` is monotonic false→true in normal operation; the effect
 *     fires exactly once per mount thanks to `hasFetchedRef`.
 *   - Unmount aborts any in-flight request (state setters bail on
 *     `controller.signal.aborted`).
 *   - 429 Too Many Requests: schedule one retry after Retry-After, then
 *     give up. Without this, every card caught in a short upstream
 *     burst is permanently "Caption unavailable".
 *   - 503 Service Unavailable: treat as silent — summaries are disabled
 *     server-side (no NVIDIA_API_KEY). Don't render an error.
 */
const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/+$/,
    ""
  ) || "";

// Clamp Retry-After to a sane range so a hostile upstream can't park
// the tab timer for hours.
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

interface Args {
  cacheKey: string | null;
  frameIndex: number;
  imageUrl: string;
  // Optional diff-mode inputs. When `prevImageUrl` is set the server
  // generates a "what changed between these two frames" caption instead
  // of a standalone description. Absent on the first card (no prior).
  prevImageUrl?: string | null;
  prevLabel?: string;
  currLabel?: string;
  initialSummary?: string;
  enabled: boolean;
}

interface State {
  summary: string;
  loading: boolean;
  error: string | null;
}

export function useSummary({
  cacheKey,
  frameIndex,
  imageUrl,
  prevImageUrl,
  prevLabel,
  currLabel,
  initialSummary,
  enabled,
}: Args): State {
  const [summary, setSummary] = useState<string>(initialSummary || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against StrictMode double-invocation and prevents duplicate
  // fetches if `enabled` somehow flipped true→false→true (shouldn't
  // happen with the current observer, but belt + braces).
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (summary) return; // already have one (initial or prior fetch)
    if (hasFetchedRef.current) return;
    if (!cacheKey) return;
    if (!imageUrl) return;

    hasFetchedRef.current = true;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const parseRetryAfter = (res: Response): number => {
      const raw = res.headers.get("Retry-After");
      if (!raw) return 5_000;
      const asInt = Number(raw);
      if (Number.isFinite(asInt) && asInt > 0) {
        return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, asInt * 1000));
      }
      const asDate = Date.parse(raw);
      if (Number.isFinite(asDate)) {
        return Math.min(
          MAX_RETRY_MS,
          Math.max(MIN_RETRY_MS, asDate - Date.now())
        );
      }
      return 5_000;
    };

    const doFetch = async (isRetry: boolean) => {
      try {
        const res = await fetch(`${API_BASE_URL}/summaries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cacheKey,
            frameIndex,
            imageUrl,
            // Only send diff fields when we actually have a prior frame
            // to compare against — the server falls back to single-image
            // mode on absence.
            ...(prevImageUrl ? { prevImageUrl, prevLabel, currLabel } : {}),
          }),
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // 429: one delayed retry, then give up.
          if (res.status === 429 && !isRetry) {
            const waitMs = parseRetryAfter(res);
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) doFetch(true);
            }, waitMs);
            return;
          }
          // 503: summaries disabled — render nothing, no error text.
          if (res.status === 503) {
            setLoading(false);
            return;
          }
          let msg = `Request failed (${res.status})`;
          try {
            const j = await res.json();
            if (j && typeof j.error === "string") msg = j.error;
          } catch {
            // default msg stands
          }
          setLoading(false);
          setError(msg);
          return;
        }
        const json = (await res.json()) as { summary?: string };
        if (cancelled) return;
        if (typeof json.summary === "string" && json.summary.trim()) {
          setSummary(json.summary.trim());
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        const e = err as { name?: string; message?: string };
        if (e.name === "AbortError") return;
        setLoading(false);
        setError(e.message || "Failed to load caption");
      }
    };

    setLoading(true);
    setError(null);
    doFetch(false);

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      controller.abort();
    };
    // `summary` and `initialSummary` intentionally excluded — they're
    // read only on the first run of this effect. `enabled` monotonically
    // flips false→true; cacheKey/frameIndex/imageUrl are stable for a
    // given MilestoneCard. prevImageUrl/prevLabel/currLabel are derived
    // from the same stable frames array, so they're also one-shot —
    // listing them here only so a hypothetical future reorder forces
    // a refetch rather than silently mixing captions across cards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, frameIndex, imageUrl, prevImageUrl, enabled]);

  return { summary, loading, error };
}
