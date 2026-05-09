import { forwardRef } from "react";
import { motion } from "framer-motion";
import { ExternalLink, Sparkles } from "lucide-react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useSummary } from "@/hooks/useSummary";
import { formatLabel, waybackSourceUrl, type Frame } from "./types";

interface Props {
  frame: Frame;
  originalUrl: string;
  isActive: boolean;
  // Null until the server's `done` SSE arrives with the manifest key —
  // without it we can't patch summaries back into the cache.
  cacheKey: string | null;
  // Caption cached server-side on a prior visit. Empty string when we've
  // never seen this frame before.
  initialSummary: string;
  // Flips true the first time this card intersects the viewport band.
  // Stays true afterward so captions don't re-fetch on every scroll.
  summaryEnabled: boolean;
}

/**
 * One snapshot in the timeline stack: date label on top, screenshot in a
 * framed card, AI caption below, Wayback deep-link in the header (only
 * for `exact` frames — we don't know which capture an `approx` frame
 * came from).
 *
 * Ref forwards to the outermost section so InteractiveTimeline can
 * register it with a single IntersectionObserver.
 */
export const MilestoneCard = forwardRef<HTMLElement, Props>(
  function MilestoneCard(
    {
      frame,
      originalUrl,
      isActive,
      cacheKey,
      initialSummary,
      summaryEnabled,
    },
    ref
  ) {
    const reduced = usePrefersReducedMotion();
    const label = formatLabel(frame);
    const waybackUrl = waybackSourceUrl(frame, originalUrl);

    const { summary, loading, error } = useSummary({
      cacheKey,
      frameIndex: frame.index,
      imageUrl: frame.url,
      initialSummary,
      enabled: summaryEnabled,
    });

    return (
      <motion.section
        ref={ref}
        data-milestone-index={frame.index}
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="scroll-mt-24"
        aria-label={`Snapshot ${label}`}
      >
        {/* Header row */}
        <header className="mb-3 flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <span
              className="font-serif text-2xl md:text-3xl"
              style={{
                color: isActive ? "var(--reel-amber)" : "var(--reel-paper)",
                fontVariantNumeric: "tabular-nums",
                transition: "color 260ms ease",
              }}
            >
              {label}
            </span>
            {frame.kind === "approx" && (
              <span
                className="font-serif text-[10px] uppercase tracking-[0.3em] opacity-50"
                title="Approximate — exact capture date unavailable"
              >
                estimate
              </span>
            )}
          </div>
          {waybackUrl && (
            <a
              href={waybackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-1.5 font-serif text-xs opacity-70 hover:opacity-100 transition-opacity"
              style={{ color: "var(--reel-paper)" }}
            >
              <span>View on Wayback</span>
              <ExternalLink
                size={12}
                className="transition-transform group-hover:translate-x-0.5"
              />
            </a>
          )}
        </header>

        {/* Screenshot frame */}
        <div
          className="relative overflow-hidden rounded-md"
          style={{
            background: "var(--reel-bg-soft)",
            border: `1px solid ${
              isActive ? "var(--reel-amber)" : "rgba(139,106,61,0.35)"
            }`,
            boxShadow: isActive
              ? "0 0 24px rgba(246,197,106,0.18)"
              : "0 2px 20px rgba(0,0,0,0.35)",
            transition: "border-color 260ms ease, box-shadow 260ms ease",
          }}
        >
          <img
            src={frame.url}
            alt={`Snapshot of ${originalUrl} from ${label}`}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        </div>

        {/* AI caption — lazy. Appears below the screenshot once the
            card enters the viewport. Hidden entirely when summaries are
            disabled server-side (the hook receives a silent 503 and we
            render nothing). */}
        <SummaryCaption summary={summary} loading={loading} error={error} />
      </motion.section>
    );
  }
);

function SummaryCaption({
  summary,
  loading,
  error,
}: {
  summary: string;
  loading: boolean;
  error: string | null;
}) {
  if (!summary && !loading && !error) return null;

  return (
    <figcaption
      className="mt-3 flex items-start gap-2 font-serif text-sm leading-relaxed"
      style={{ color: "rgba(234,220,196,0.82)" }}
    >
      <Sparkles
        size={14}
        className="mt-1 flex-shrink-0"
        style={{ color: "var(--reel-amber)", opacity: 0.7 }}
        aria-hidden
      />
      <span className="flex-1">
        {summary && <span>{summary}</span>}
        {!summary && loading && (
          <span className="inline-flex items-center gap-1 opacity-60">
            <span
              className="inline-block h-2 w-2 animate-pulse rounded-full"
              style={{ background: "var(--reel-amber)" }}
            />
            <span className="italic">Writing caption…</span>
          </span>
        )}
        {!summary && !loading && error && (
          <span className="text-xs italic opacity-50">
            Caption unavailable
          </span>
        )}
      </span>
    </figcaption>
  );
}
