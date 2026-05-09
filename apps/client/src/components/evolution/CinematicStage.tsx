import { useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useCinematicPlayback } from "@/hooks/useCinematicPlayback";
import { FrameProjector } from "./FrameProjector";
import { YearOdometer } from "./YearOdometer";
import { TimelineRail } from "./TimelineRail";
import { PlaybackControls } from "./PlaybackControls";
import { GrainOverlay } from "./GrainOverlay";
import { FinaleMontage } from "./FinaleMontage";
import type { Frame } from "./types";

interface Props {
  frames: Frame[];
  url: string;
  startYear: number;
  endYear: number;
  onClose: () => void;
}

export function CinematicStage({ frames, url, startYear, endYear, onClose }: Props) {
  const api = useCinematicPlayback(frames.length, { defaultFrameMs: 2800 });
  const currentFrame = frames[api.currentIndex];

  // Preload all frames so transitions don't stall.
  useEffect(() => {
    frames.forEach((f) => {
      const img = new Image();
      img.src = f.url;
    });
  }, [frames]);

  // Escape closes the stage.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Host label — strip protocol for visual tidiness.
  const prettyUrl = useMemo(() => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  }, [url]);

  const isFinale = api.state === "finished";

  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
      className="fixed inset-0 z-50 overflow-hidden"
      style={{ background: "var(--reel-bg)", color: "var(--reel-paper)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Website evolution reel"
    >
      <GrainOverlay />

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.5 }}
        className="absolute top-6 left-6 right-6 flex items-start justify-between z-10"
      >
        <div className="flex flex-col gap-1">
          <span
            className="text-[10px] uppercase tracking-[0.5em] opacity-60 font-serif"
          >
            Webrewind · The Archive
          </span>
          <span className="text-sm font-serif opacity-90">
            Rewinding{" "}
            <span style={{ color: "var(--reel-amber)" }}>{prettyUrl}</span>
            <span className="opacity-50 mx-2">·</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {startYear}–{endYear}
            </span>
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close reel"
          className="flex items-center gap-2 text-[var(--reel-paper)]/70 hover:text-[var(--reel-paper)] transition-colors"
        >
          <span className="text-[10px] uppercase tracking-[0.3em] font-serif">Close</span>
          <X size={18} />
        </button>
      </motion.header>

      {/* Stage */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.3, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="absolute inset-0 flex flex-col items-center justify-center pt-24 pb-40 gap-8"
      >
        {/* Year odometer */}
        {!isFinale && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.5 }}
          >
            <YearOdometer year={currentFrame?.year ?? startYear} />
          </motion.div>
        )}

        {/* Main visual */}
        {isFinale ? (
          <FinaleMontage frames={frames} onSelect={api.seek} />
        ) : (
          currentFrame && <FrameProjector frame={currentFrame} />
        )}
      </motion.div>

      {/* Footer: timeline + controls */}
      <motion.footer
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.55, duration: 0.55 }}
        className="absolute bottom-0 inset-x-0 px-10 pb-8 pt-4 z-10"
        style={{
          background:
            "linear-gradient(to top, rgba(13,11,8,0.95), rgba(13,11,8,0))",
        }}
      >
        <div className="max-w-6xl mx-auto flex flex-col gap-3">
          <TimelineRail
            frames={frames}
            currentIndex={api.currentIndex}
            onScrub={api.seek}
          />
          <PlaybackControls {...api} total={frames.length} />
        </div>
      </motion.footer>
    </motion.section>
  );
}
