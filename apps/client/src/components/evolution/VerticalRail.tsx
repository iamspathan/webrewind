import { useEffect, useRef } from "react";
import { animate, stagger } from "animejs";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { Frame } from "./types";

interface Props {
  frames: Frame[];
  activeIndex: number;
  onJump: (index: number) => void;
}

/**
 * Vertical sibling of the old horizontal TimelineRail. A sticky column on
 * the left of InteractiveTimeline: SVG line with one dot + year label per
 * frame. `activeIndex` is driven by the parent's IntersectionObserver;
 * clicking a dot asks the parent to scroll its card into view.
 *
 * The viewBox height is sized per-mount so rows stay evenly spaced no
 * matter how many frames the job returned.
 */
export function VerticalRail({ frames, activeIndex, onJump }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mountedRef = useRef(false);
  const reduced = usePrefersReducedMotion();

  // Space rows at a fixed step in SVG user units. 10px of headroom top &
  // bottom so the endpoints don't clip against the container.
  const ROW = 16;
  const TOP = 10;
  const viewH = TOP * 2 + Math.max(0, frames.length - 1) * ROW;
  const divisor = Math.max(1, frames.length - 1);

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

  const playheadY = TOP + (activeIndex / divisor) * (viewH - TOP * 2);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 60 ${viewH}`}
      preserveAspectRatio="xMidYMin meet"
      className="h-full w-full"
      role="list"
      aria-label="Timeline milestones"
    >
      <path
        data-rail
        d={`M 18 ${TOP} L 18 ${viewH - TOP}`}
        stroke="var(--reel-sepia)"
        strokeWidth="0.5"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
      {frames.map((f, i) => {
        const y = TOP + (i / divisor) * (viewH - TOP * 2);
        const isActive = i === activeIndex;
        return (
          <g
            key={f.index}
            data-dot
            transform={`translate(18 ${y})`}
            style={{ transformOrigin: "center", cursor: "pointer" }}
            onClick={() => onJump(i)}
            role="listitem"
            aria-current={isActive ? "true" : undefined}
          >
            <circle
              r={isActive ? 2.4 : 1.2}
              fill={isActive ? "var(--reel-amber)" : "var(--reel-paper)"}
              style={{ transition: "r 260ms ease, fill 260ms ease" }}
            />
            {isActive && !reduced && (
              <circle r={4.5} fill="var(--reel-amber)" opacity={0.22}>
                <animate
                  attributeName="r"
                  values="3.2;5.2;3.2"
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </circle>
            )}
          </g>
        );
      })}
      <line
        x1={12}
        x2={24}
        y1={playheadY}
        y2={playheadY}
        stroke="var(--reel-amber-glow)"
        strokeWidth={0.5}
        strokeLinecap="round"
        style={{
          transition: "all 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          filter: "drop-shadow(0 0 1px var(--reel-amber))",
        }}
      />
      {frames.map((f, i) => {
        const y = TOP + (i / divisor) * (viewH - TOP * 2);
        const isActive = i === activeIndex;
        return (
          <text
            key={`yr-${f.index}`}
            data-yr
            x={30}
            y={y + 1.2}
            fontSize={3.5}
            fill="var(--reel-paper)"
            opacity={isActive ? 0.95 : 0.55}
            style={{
              fontFamily: '"IBM Plex Serif", Georgia, serif',
              letterSpacing: "0.1em",
              transition: "opacity 260ms ease",
              cursor: "pointer",
              fontVariantNumeric: "tabular-nums",
            }}
            onClick={() => onJump(i)}
          >
            {f.year}
          </text>
        );
      })}
    </svg>
  );
}
