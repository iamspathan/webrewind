import { useEffect, useRef } from "react";
import { animate, stagger } from "animejs";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { Frame } from "./types";

interface Props {
  frames: Frame[];
  currentIndex: number;
  onScrub: (i: number) => void;
}

export function TimelineRail({ frames, currentIndex, onScrub }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mountedRef = useRef(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!svgRef.current || mountedRef.current) return;
    mountedRef.current = true;

    const line = svgRef.current.querySelector<SVGPathElement>("[data-rail]");
    const dots = svgRef.current.querySelectorAll<SVGGElement>("[data-dot]");
    const labels = svgRef.current.querySelectorAll<SVGTextElement>("[data-yr]");

    if (line) {
      const length = line.getTotalLength();
      line.style.strokeDasharray = `${length}`;
      line.style.strokeDashoffset = `${length}`;
      if (reduced) {
        line.style.strokeDashoffset = "0";
      } else {
        animate(line, {
          strokeDashoffset: [length, 0],
          duration: 700,
          ease: "outQuart",
        });
      }
    }

    if (!reduced) {
      animate(dots, {
        opacity: [0, 1],
        scale: [0.4, 1],
        delay: stagger(40, { start: 300 }),
        duration: 400,
        ease: "outBack",
      });
      animate(labels, {
        opacity: [0, 0.55],
        delay: stagger(40, { start: 500 }),
        duration: 500,
        ease: "outQuart",
      });
    }
  }, [reduced]);

  const divisor = Math.max(1, frames.length - 1);
  const playheadX = (currentIndex / divisor) * 100;

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * divisor);
    onScrub(idx);
  };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 12"
      preserveAspectRatio="none"
      className="w-full h-14 cursor-pointer"
      onClick={handleClick}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={frames.length - 1}
      aria-valuenow={currentIndex}
      aria-label="Timeline scrubber"
    >
      <path
        data-rail
        d="M 0.5 5 L 99.5 5"
        stroke="var(--reel-sepia)"
        strokeWidth="0.25"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
      {frames.map((f, i) => {
        const x = (i / divisor) * 100;
        const isActive = i === currentIndex;
        return (
          <g
            key={f.index}
            data-dot
            transform={`translate(${x} 5)`}
            style={{ transformOrigin: "center" }}
          >
            <circle
              r={isActive ? 1.1 : 0.55}
              fill={isActive ? "var(--reel-amber)" : "var(--reel-paper)"}
              style={{ transition: "r 260ms ease, fill 260ms ease" }}
            />
            {isActive && (
              <circle r={2.4} fill="var(--reel-amber)" opacity={0.22}>
                <animate
                  attributeName="r"
                  values="1.6;2.8;1.6"
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
          </g>
        );
      })}
      <line
        x1={playheadX}
        x2={playheadX}
        y1={2}
        y2={8}
        stroke="var(--reel-amber-glow)"
        strokeWidth={0.2}
        strokeLinecap="round"
        style={{
          transition: "all 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          filter: "drop-shadow(0 0 0.6px var(--reel-amber))",
        }}
      />
      {frames.map((f, i) => {
        const showEveryNth = Math.max(1, Math.ceil(frames.length / 8));
        if (i !== 0 && i !== frames.length - 1 && i % showEveryNth !== 0) return null;
        const x = (i / divisor) * 100;
        return (
          <text
            key={`yr-${f.index}`}
            data-yr
            x={x}
            y={11}
            textAnchor="middle"
            fontSize={1.5}
            fill="var(--reel-paper)"
            opacity={0}
            style={{
              fontFamily: '"IBM Plex Serif", Georgia, serif',
              letterSpacing: "0.1em",
            }}
          >
            {f.year}
          </text>
        );
      })}
    </svg>
  );
}
