import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Download, X } from "lucide-react";
import { MilestoneCard } from "./MilestoneCard";
import { VerticalRail } from "./VerticalRail";
import type { Frame } from "./types";

interface Props {
  frames: Frame[];
  url: string;
  startYear: number;
  endYear: number;
  onClose: () => void;
  // Cache manifest key — passed through to MilestoneCards so /summaries
  // knows which manifest to patch. Null when the server didn't emit one
  // (older cache entries); captions are disabled in that case.
  cacheKey: string | null;
  // Initial caption per frame, aligned 1:1 with `frames`. Empty strings
  // for slots the server hasn't summarized yet.
  summaries: string[];
  // Public URL of the encoded GIF. When present, the finale block plays
  // it at the end of the timeline. Null in preview mode / older
  // responses — finale is simply omitted.
  gifUrl: string | null;
}

/**
 * Scroll-driven edutainment timeline. Replaces the previous full-screen
 * cinematic reel. Inline (not a portal) so the page header stays visible
 * and native browser scrolling drives the experience — the user reads
 * history top-to-bottom like a feed.
 *
 * A single IntersectionObserver watches every MilestoneCard. The card
 * whose centre is closest to the viewport midline becomes the `active`
 * one; that index drives the rail's playhead + glow. `rootMargin` crops
 * a 40% slab off the top and bottom so activation happens in the
 * centre-ish third, not as soon as any pixel enters the viewport.
 */
export function InteractiveTimeline({
  frames,
  url,
  startYear,
  endYear,
  onClose,
  cacheKey,
  summaries,
  gifUrl,
}: Props) {
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const finaleRef = useRef<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Defer loading the (potentially multi-MB) GIF until the finale
  // section is within a viewport of the user's scroll position. Once
  // flipped true we never go back — reloading the GIF on scroll-away
  // would restart its animation and waste bandwidth.
  const [finaleVisible, setFinaleVisible] = useState(false);
  // Tracks which cards have ever entered the viewport — once true, we
  // let the caption fetch start and never disable it again (scrolling
  // past shouldn't abort an in-flight LLM call, and re-entering
  // shouldn't trigger a refetch).
  const [seen, setSeen] = useState<Set<number>>(() => new Set());

  // Keep the ref array sized to frames.length. Done in an effect, not
  // during render, so StrictMode's double-render and React concurrent
  // features don't see a mutation during the render phase.
  useEffect(() => {
    cardRefs.current.length = frames.length;
  }, [frames.length]);

  const registerCard = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      cardRefs.current[index] = el;
    },
    []
  );

  const handleJump = useCallback((index: number) => {
    const el = cardRefs.current[index];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Host label — strip protocol for visual tidiness.
  const prettyUrl = useMemo(() => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  }, [url]);

  // IntersectionObserver: flip activeIndex whenever a card crosses the
  // centre band. We don't try to pick "closest to centre" — the
  // rootMargin makes at most one card qualify at a time in practice.
  useEffect(() => {
    if (frames.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the most-visible intersecting card if multiple cross the
        // threshold at once (happens on short cards).
        let bestIdx = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number(
            (entry.target as HTMLElement).dataset.milestoneIndex
          );
          if (Number.isNaN(idx)) continue;
          if (entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestIdx = idx;
          }
        }
        if (bestIdx >= 0) setActiveIndex(bestIdx);
      },
      {
        // Crop a 40% slab off the top and bottom. Only the middle 20%
        // of the viewport counts as the "active" band.
        rootMargin: "-40% 0px -40% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );
    const els = cardRefs.current.filter(
      (el): el is HTMLElement => el !== null
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [frames.length]);

  // A second, looser observer drives caption prefetching. A generous
  // rootMargin lets the LLM call kick off before the card hits the
  // viewport centre, so the caption is usually ready by the time the
  // user pauses on it. Once a card is seen we never remove it from the
  // set — captions are one-shot per session.
  useEffect(() => {
    if (frames.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Collect indices that crossed in this tick and defer the merge
        // to setSeen's functional form. We must NOT close over `seen`
        // here — `seen` is deliberately excluded from the effect's deps
        // (re-running would tear the observer down every time a card
        // enters view), so any reference to `seen` inside this callback
        // reads the value from the effect's first run. Functional
        // setState uses React's latest state instead.
        const incoming: number[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number(
            (entry.target as HTMLElement).dataset.milestoneIndex
          );
          if (Number.isNaN(idx)) continue;
          incoming.push(idx);
        }
        if (incoming.length === 0) return;
        setSeen((prev) => {
          let next: Set<number> | null = null;
          for (const idx of incoming) {
            if (prev.has(idx)) continue;
            if (!next) next = new Set(prev);
            next.add(idx);
          }
          return next || prev;
        });
      },
      {
        // Start fetching when a card is within ~one viewport of the
        // user's scroll position.
        rootMargin: "0px 0px 200px 0px",
        threshold: 0,
      }
    );
    const els = cardRefs.current.filter(
      (el): el is HTMLElement => el !== null
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [frames.length]);

  // One-shot observer: flip `finaleVisible` when the finale block is
  // within ~one viewport of the user. Disconnects as soon as it fires.
  useEffect(() => {
    if (!gifUrl) return;
    const el = finaleRef.current;
    if (!el) return;
    if (finaleVisible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setFinaleVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: "0px 0px 400px 0px", threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [gifUrl, finaleVisible]);

  // Escape closes the view — keeps parity with the old CinematicStage.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="w-full"
      aria-label="Website evolution timeline"
    >
      {/* Sticky header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 py-4 backdrop-blur-md"
        style={{
          background: "rgba(13,11,8,0.78)",
          borderBottom: "1px solid rgba(139,106,61,0.25)",
          color: "var(--reel-paper)",
        }}
      >
        <div className="flex flex-col gap-0.5">
          <span className="font-serif text-[10px] uppercase tracking-[0.45em] opacity-60">
            The Archive
          </span>
          <span className="font-serif text-sm">
            <span style={{ color: "var(--reel-amber)" }}>{prettyUrl}</span>
            <span className="opacity-50 mx-2">·</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {startYear}–{endYear}
            </span>
            <span className="opacity-50 mx-2">·</span>
            <span
              className="opacity-70"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {frames.length} snapshots
            </span>
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close timeline"
          className="flex items-center gap-2 opacity-70 hover:opacity-100 transition-opacity"
          style={{ color: "var(--reel-paper)" }}
        >
          <span className="font-serif text-[10px] uppercase tracking-[0.3em]">
            Close
          </span>
          <X size={16} />
        </button>
      </header>

      {/* Rail + cards grid */}
      <div className="grid gap-6 px-4 py-10 md:grid-cols-[120px_1fr] md:gap-10 md:px-8">
        {/* Left rail — sticky within its column */}
        <div
          className="hidden md:block"
          style={{
            position: "sticky",
            top: 96, // sits below the sticky header
            height: "calc(100vh - 120px)",
          }}
        >
          <VerticalRail
            frames={frames}
            activeIndex={activeIndex}
            onJump={handleJump}
          />
        </div>

        {/* Cards column */}
        <div className="flex flex-col gap-16 md:gap-24 max-w-4xl">
          {frames.map((frame, i) => (
            <MilestoneCard
              key={frame.index}
              ref={registerCard(i)}
              frame={frame}
              originalUrl={url}
              isActive={i === activeIndex}
              cacheKey={cacheKey}
              initialSummary={summaries[frame.index] || ""}
              // First card gets an eager fetch — everyone else waits
              // for IntersectionObserver. Without this, the top card
              // never animates in a caption on page load because IO
              // doesn't fire for elements already in the viewport at
              // observer-creation time on every browser.
              summaryEnabled={i === 0 || seen.has(frame.index)}
            />
          ))}

          {gifUrl && (
            <section
              ref={(el) => {
                finaleRef.current = el;
              }}
              aria-label="Evolution reel"
              className="flex flex-col gap-5 pt-10"
              style={{
                borderTop: "1px solid rgba(139,106,61,0.25)",
              }}
            >
              <div className="flex flex-col gap-1">
                <span
                  className="font-serif text-[10px] uppercase tracking-[0.45em]"
                  style={{ color: "var(--reel-amber)" }}
                >
                  The Reel
                </span>
                <h3
                  className="font-serif text-2xl md:text-3xl"
                  style={{ color: "var(--reel-paper)" }}
                >
                  {frames.length} years in {frames.length} frames
                </h3>
                <p
                  className="text-sm opacity-70"
                  style={{ color: "var(--reel-paper)" }}
                >
                  The full evolution, stitched into a loop.
                </p>
              </div>

              <div
                className="relative overflow-hidden rounded-md"
                style={{
                  background: "var(--reel-bg-soft)",
                  border: "1px solid rgba(139,106,61,0.3)",
                }}
              >
                {finaleVisible ? (
                  <img
                    src={gifUrl}
                    alt={`Animated evolution of ${prettyUrl}`}
                    className="block w-full h-auto"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div
                    className="flex items-center justify-center"
                    style={{
                      aspectRatio: "16 / 10",
                      color: "var(--reel-paper)",
                      opacity: 0.5,
                    }}
                  >
                    <span className="font-serif text-xs uppercase tracking-[0.3em]">
                      Scroll to play
                    </span>
                  </div>
                )}
              </div>

              <a
                href={gifUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 self-start opacity-80 hover:opacity-100 transition-opacity"
                style={{ color: "var(--reel-amber)" }}
              >
                <Download size={14} />
                <span className="font-serif text-[11px] uppercase tracking-[0.3em]">
                  Download GIF
                </span>
              </a>
            </section>
          )}
        </div>
      </div>
    </motion.section>
  );
}
