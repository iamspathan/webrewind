import { AnimatePresence, motion } from "framer-motion";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { Frame } from "./types";

interface Props {
  frame: Frame;
  showFlash?: boolean;
}

function FilmEdges() {
  const holes = Array.from({ length: 14 });
  return (
    <>
      <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-4 bg-[var(--reel-bg-soft)] flex flex-col items-center justify-around py-2">
        {holes.map((_, i) => (
          <span
            key={i}
            className="block w-2 h-2 rounded-sm"
            style={{ background: "var(--reel-bg)" }}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-4 bg-[var(--reel-bg-soft)] flex flex-col items-center justify-around py-2">
        {holes.map((_, i) => (
          <span
            key={i}
            className="block w-2 h-2 rounded-sm"
            style={{ background: "var(--reel-bg)" }}
          />
        ))}
      </div>
    </>
  );
}

export function FrameProjector({ frame, showFlash = true }: Props) {
  const reduced = usePrefersReducedMotion();
  const variant = frame.index % 4;

  return (
    <div
      className="relative w-[min(92vw,1400px)] max-h-[78vh] overflow-hidden ring-1 ring-[var(--reel-sepia)]/40"
      style={{
        // Screenshots are captured at 1366×1366 (square viewport). Use a
        // square aspect so `object-contain` fills the whole frame with no
        // letterboxing in either direction.
        aspectRatio: "1 / 1",
        boxShadow:
          "0 40px 120px rgba(0,0,0,0.7), inset 0 0 80px rgba(139,106,61,0.15)",
        background: "var(--reel-bg-soft)",
      }}
    >
      <FilmEdges />

      <AnimatePresence mode="popLayout">
        <motion.div
          key={frame.url}
          className="absolute inset-0"
          initial={{
            opacity: 0,
            scale: reduced ? 1 : 1.04,
            filter: reduced ? "sepia(0.18)" : "blur(8px) sepia(0.18)",
          }}
          animate={{
            opacity: 1,
            scale: 1,
            filter: "sepia(0.18) contrast(1.05)",
            transition: {
              duration: reduced ? 0.15 : 0.9,
              ease: [0.22, 1, 0.36, 1],
            },
          }}
          exit={{
            opacity: 0,
            scale: reduced ? 1 : 1.01,
            filter: reduced ? "sepia(0.18)" : "blur(3px) sepia(0.18)",
            transition: { duration: reduced ? 0.1 : 0.5, ease: "easeIn" },
          }}
        >
          {/* object-contain preserves the full screenshot — no cropping.
              Padding leaves room for the film-strip sprocket edges. */}
          <img
            src={frame.url}
            alt={`Website snapshot ${frame.year}`}
            className="absolute inset-0 h-full w-full object-contain object-center px-5"
            data-variant={variant}
            draggable={false}
          />
        </motion.div>
      </AnimatePresence>

      {/* vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, rgba(13,11,8,0.55) 100%)",
        }}
      />

      {/* shutter flash — keyed on frame so it re-triggers per snapshot */}
      {showFlash && !reduced && (
        <motion.div
          key={`flash-${frame.index}`}
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-white"
          initial={{ opacity: 0.55 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        />
      )}
    </div>
  );
}
