import { motion } from "framer-motion";
import { Play, Pause, SkipBack, SkipForward, RotateCcw } from "lucide-react";
import type { PlaybackApi, PlaybackSpeed } from "@/hooks/useCinematicPlayback";

interface Props extends PlaybackApi {
  total: number;
}

const SPEEDS: PlaybackSpeed[] = [0.5, 1, 1.5, 2];

export function PlaybackControls({
  state,
  currentIndex,
  speed,
  play,
  pause,
  next,
  prev,
  restart,
  setSpeed,
  total,
}: Props) {
  const isPlaying = state === "playing";
  const isFinished = state === "finished";

  return (
    <div className="flex items-center justify-between gap-6 w-full">
      <div className="text-xs uppercase tracking-[0.3em] text-[var(--reel-paper)]/60 font-serif">
        Frame {String(currentIndex + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </div>

      <div className="flex items-center gap-3">
        <ControlButton onClick={prev} disabled={currentIndex === 0} label="Previous frame">
          <SkipBack />
        </ControlButton>

        <motion.button
          onClick={isFinished ? restart : isPlaying ? pause : play}
          className="flex items-center justify-center rounded-full border border-[var(--reel-amber)]/60 text-[var(--reel-paper)] hover:bg-[var(--reel-amber)]/15 transition-colors"
          style={{ width: 56, height: 56 }}
          aria-label={isFinished ? "Replay" : isPlaying ? "Pause" : "Play"}
          animate={
            state === "idle"
              ? { scale: [1, 1.06, 1], boxShadow: [
                  "0 0 0 0 rgba(212,162,76,0.5)",
                  "0 0 0 14px rgba(212,162,76,0)",
                  "0 0 0 0 rgba(212,162,76,0)",
                ] }
              : { scale: 1, boxShadow: "0 0 0 0 rgba(212,162,76,0)" }
          }
          transition={
            state === "idle"
              ? { duration: 1.8, repeat: Infinity, ease: "easeOut" }
              : { duration: 0.2 }
          }
        >
          {isFinished ? <RotateCcw size={22} /> : isPlaying ? <Pause size={22} /> : <Play size={22} />}
        </motion.button>

        <ControlButton
          onClick={next}
          disabled={currentIndex === total - 1 && !isFinished}
          label="Next frame"
        >
          <SkipForward />
        </ControlButton>
      </div>

      <div className="flex items-center gap-1.5">
        {SPEEDS.map((s) => {
          const active = s === speed;
          return (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className="px-2.5 py-1 rounded-sm text-xs font-serif tracking-wider transition-colors"
              style={{
                color: active ? "var(--reel-bg)" : "var(--reel-paper)",
                background: active ? "var(--reel-amber)" : "transparent",
                border: `1px solid ${active ? "var(--reel-amber)" : "rgba(139,106,61,0.45)"}`,
                fontVariantNumeric: "tabular-nums",
              }}
              aria-label={`Playback speed ${s}x`}
              aria-pressed={active}
            >
              {s}×
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex items-center justify-center w-10 h-10 rounded-full text-[var(--reel-paper)]/80 hover:text-[var(--reel-paper)] hover:bg-[var(--reel-paper)]/8 disabled:opacity-30 disabled:pointer-events-none transition-colors"
    >
      {children}
    </button>
  );
}
