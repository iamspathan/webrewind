import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, Loader2 } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface Props {
  startYear: number;
  endYear: number;
  url: string;
  /** true when the server response has arrived — progress snaps to 100. */
  finalizing: boolean;
  /** Live capture counts from the SSE stream. */
  captured?: number;
  total?: number;
  /** Frames that failed to capture (counted toward progress). */
  skipped?: number;
  /** Short phase label from the server: "starting" | "fetching-urls" |
   *  "capturing" | "encoding-gif" | null */
  phase?: string | null;
  /** ms per year; tuned to typical Puppeteer cost. Used only for ETA before
   *  we have enough real samples to extrapolate. */
  msPerYear?: number;
  /** Sliding window of recently captured frames, pre-sorted by index.
   *  Empty array means "no frames yet — don't render the strip". */
  capturedFrames?: { index: number; imageUrl: string; timestamp?: string }[];
}

type YearState = "pending" | "capturing" | "captured";

/**
 * Three display modes:
 *
 *   1. Pre-capture ("starting" / "fetching-urls"):
 *      indeterminate shimmer bar, phase label, no percentage. We intentionally
 *      do NOT march a simulated % during this phase because it's usually
 *      Wayback rate-limit retries and can take a while — showing fake
 *      captures while nothing is happening misleads the user.
 *
 *   2. Capturing (server has reported a `total`):
 *      real progress (captured / total), ETA extrapolated from observed
 *      per-frame time.
 *
 *   3. Finalizing (server emitted `done`):
 *      snap to 100% and show "Assembling reel…".
 */
export function CaptureProgress({
  startYear,
  endYear,
  url,
  finalizing,
  captured = 0,
  total = 0,
  skipped = 0,
  phase = null,
  msPerYear = 2500,
  capturedFrames = [],
}: Props) {
  const reduced = usePrefersReducedMotion();
  const years = useMemo(() => {
    const count = Math.max(1, endYear - startYear + 1);
    return Array.from({ length: count }, (_, i) => startYear + i);
  }, [startYear, endYear]);

  // Elapsed wall-clock since the capturing phase began — used for ETA only.
  const [elapsedSinceCapturing, setElapsedSinceCapturing] = useState(0);
  const captureStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // Auto-scroll the thumbnail strip to the newest frame whenever it grows.
  const thumbStripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = thumbStripRef.current;
    if (!el || capturedFrames.length === 0) return;
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [capturedFrames.length]);

  const haveTotal = total > 0;

  // Start the capture-phase clock the moment `total` arrives. Reset it if
  // total drops back to 0 (e.g. a re-submit).
  useEffect(() => {
    if (haveTotal && captureStartRef.current === null) {
      captureStartRef.current = performance.now();
    }
    if (!haveTotal) {
      captureStartRef.current = null;
      setElapsedSinceCapturing(0);
    }
  }, [haveTotal]);

  useEffect(() => {
    const tick = (now: number) => {
      if (captureStartRef.current !== null) {
        setElapsedSinceCapturing(now - captureStartRef.current);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // --- Display state --------------------------------------------------------
  const isPreCapture =
    !finalizing && !haveTotal && (phase === "starting" || phase === "fetching-urls" || phase == null);

  const realPct = haveTotal ? Math.min(1, captured / total) : 0;
  const pct = finalizing ? 1 : realPct;
  const pctInt = Math.round(pct * 100);

  // Per-year visual cursor: rough mapping from real progress onto the year
  // axis. Only meaningful once capturing starts.
  const captureCursor = finalizing
    ? years.length
    : haveTotal
    ? Math.min(years.length - 1, Math.floor(realPct * years.length))
    : 0;

  const getYearState = (i: number): YearState => {
    if (finalizing) return "captured";
    if (!haveTotal) return "pending";
    if (i < captureCursor) return "captured";
    if (i === captureCursor) return "capturing";
    return "pending";
  };

  const totalCount = haveTotal ? total : years.length;
  const capturedCount = finalizing ? totalCount : haveTotal ? captured : 0;
  const remainingCount = Math.max(0, totalCount - capturedCount);

  // ETA: prefer extrapolation from observed per-frame time once we have at
  // least one capture; otherwise fall back to the msPerYear heuristic.
  const remainingSec = !haveTotal
    ? null
    : capturedCount > 0
    ? Math.max(
        0,
        Math.round(
          ((elapsedSinceCapturing / capturedCount) * remainingCount) / 1000
        )
      )
    : Math.max(0, Math.round((remainingCount * msPerYear) / 1000));

  const almostDone = finalizing || (haveTotal && realPct >= 0.9);

  const phaseLabel =
    phase === "fetching-urls"
      ? "Asking Wayback for snapshots…"
      : phase === "encoding-gif"
      ? "Encoding GIF…"
      : phase === "starting"
      ? "Warming up…"
      : null;

  const statusLabel = finalizing
    ? "Assembling reel…"
    : phase === "encoding-gif"
    ? "Encoding GIF…"
    : isPreCapture
    ? phaseLabel ?? "Warming up…"
    : almostDone
    ? "Almost done…"
    : `Capturing ${Math.min(capturedCount + 1, totalCount)} of ${totalCount}`;

  const prettyUrl = useMemo(() => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  }, [url]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="w-full rounded-lg overflow-hidden"
      style={{
        background: "var(--reel-bg-soft)",
        border: "1px solid rgba(139,106,61,0.35)",
        color: "var(--reel-paper)",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="px-6 pt-6 pb-5 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {!reduced && (
              <Loader2
                className="animate-spin"
                size={16}
                style={{ color: "var(--reel-amber)" }}
              />
            )}
            <div className="flex flex-col">
              <span
                className="text-[10px] uppercase tracking-[0.4em] opacity-60 font-serif"
              >
                Capturing snapshots
              </span>
              <span className="text-sm font-serif">
                <span style={{ color: "var(--reel-amber)" }}>{prettyUrl}</span>
                <span className="opacity-50 mx-2">·</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {startYear}–{endYear}
                </span>
              </span>
            </div>
          </div>
          {/* Percentage hidden during pre-capture — a bogus number is worse
              than no number. */}
          {!isPreCapture && (
            <div
              className="font-serif text-3xl leading-none"
              style={{
                color: "var(--reel-amber)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {pctInt}
              <span className="text-base opacity-70">%</span>
            </div>
          )}
        </div>

        {/* Progress bar — indeterminate shimmer in pre-capture, real % once
            capturing begins. */}
        <div className="relative">
          <div
            className="h-1.5 w-full rounded-full overflow-hidden"
            style={{ background: "rgba(244,234,213,0.08)" }}
          >
            {isPreCapture ? (
              <motion.div
                key="indeterminate"
                className="h-full rounded-full"
                style={{
                  width: "30%",
                  background:
                    "linear-gradient(90deg, transparent, var(--reel-amber), transparent)",
                  boxShadow: "0 0 10px rgba(246,197,106,0.4)",
                }}
                animate={
                  reduced
                    ? { x: 0 }
                    : { x: ["-120%", "340%"] }
                }
                transition={
                  reduced
                    ? { duration: 0 }
                    : {
                        duration: 1.8,
                        ease: "easeInOut",
                        repeat: Infinity,
                      }
                }
              />
            ) : (
              <motion.div
                key="determinate"
                className="h-full rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, var(--reel-sepia), var(--reel-amber) 60%, var(--reel-amber-glow))",
                  boxShadow: "0 0 10px rgba(246,197,106,0.6)",
                }}
                animate={{ width: `${pctInt}%` }}
                transition={{
                  duration: finalizing ? 0.5 : 0.25,
                  ease: finalizing ? [0.22, 1, 0.36, 1] : "linear",
                }}
              />
            )}
          </div>
        </div>

        {/* Year chips */}
        <div className="flex flex-wrap gap-1.5">
          {years.map((year, i) => {
            const state = getYearState(i);
            return (
              <YearChip key={year} year={year} state={state} reduced={reduced} />
            );
          })}
        </div>

        {/* Thumbnail strip — only renders once real frames arrive. Bounded by
            the sliding window on the caller side; still add overflow-x-auto
            for safety when the window is wider than the card. */}
        {capturedFrames.length > 0 && !finalizing && (
          <div
            ref={thumbStripRef}
            className="flex gap-2 overflow-x-auto py-1 -mx-1 px-1 scrollbar-thin"
            style={{
              scrollbarWidth: "thin",
            }}
            aria-label="Recently captured frames"
          >
            {capturedFrames.map((frame) => {
              const year = frame.timestamp
                ? frame.timestamp.slice(0, 4)
                : undefined;
              return (
                <motion.div
                  key={frame.index}
                  layout
                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  className="relative shrink-0 overflow-hidden rounded-sm"
                  style={{
                    height: 72,
                    width: 112,
                    border: "1px solid rgba(139,106,61,0.4)",
                    background: "rgba(13,11,8,0.5)",
                  }}
                >
                  <img
                    src={frame.imageUrl}
                    alt={`Frame ${frame.index}${year ? ` · ${year}` : ""}`}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-top"
                  />
                  {year && (
                    <span
                      className="absolute bottom-1 left-1 font-serif text-[10px] px-1 py-0.5 rounded-sm"
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        background: "rgba(13,11,8,0.75)",
                        color: "var(--reel-paper)",
                      }}
                    >
                      {year}
                    </span>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Status line */}
        <div className="flex items-center justify-between text-xs font-serif">
          <span className="opacity-80">{statusLabel}</span>
          <span
            className="opacity-60"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {isPreCapture ? (
              <>preparing…</>
            ) : finalizing ? (
              <>
                {totalCount} / {totalCount} captured
                {skipped > 0 && (
                  <span className="opacity-70"> · {skipped} skipped</span>
                )}
              </>
            ) : (
              <>
                {capturedCount} / {totalCount} captured
                {remainingSec !== null && (
                  <>
                    {" "}·{" "}
                    {remainingCount === 0
                      ? "wrapping up"
                      : `~${remainingSec}s left`}
                  </>
                )}
                {skipped > 0 && (
                  <span className="opacity-70"> · {skipped} skipped</span>
                )}
              </>
            )}
          </span>
        </div>
      </div>

      <footer
        className="px-6 py-2.5 text-[10px] uppercase tracking-[0.3em] opacity-50 font-serif"
        style={{
          background: "rgba(13,11,8,0.5)",
          borderTop: "1px solid rgba(139,106,61,0.25)",
        }}
      >
        {isPreCapture
          ? "live · waiting on the wayback machine"
          : "live · streaming from the server, frame by frame"}
      </footer>
    </motion.section>
  );
}

function YearChip({
  year,
  state,
  reduced,
}: {
  year: number;
  state: YearState;
  reduced: boolean;
}) {
  const base =
    "inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[11px] font-serif transition-colors duration-300";

  let style: React.CSSProperties;
  if (state === "captured") {
    style = {
      color: "var(--reel-bg)",
      background: "var(--reel-amber)",
      border: "1px solid var(--reel-amber)",
    };
  } else if (state === "capturing") {
    style = {
      color: "var(--reel-amber-glow)",
      background: "rgba(246,197,106,0.1)",
      border: "1px solid var(--reel-amber)",
    };
  } else {
    style = {
      color: "var(--reel-paper)",
      background: "transparent",
      border: "1px solid rgba(139,106,61,0.45)",
      opacity: 0.6,
    };
  }

  return (
    <motion.span
      layout
      className={base}
      style={{ ...style, fontVariantNumeric: "tabular-nums" }}
      animate={
        state === "capturing" && !reduced
          ? { scale: [1, 1.05, 1] }
          : { scale: 1 }
      }
      transition={
        state === "capturing" && !reduced
          ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
          : { duration: 0.2 }
      }
    >
      {state === "captured" && <Check size={10} strokeWidth={3} />}
      {state === "capturing" && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{
            background: "var(--reel-amber)",
            boxShadow: "0 0 6px var(--reel-amber-glow)",
          }}
        />
      )}
      {year}
    </motion.span>
  );
}
