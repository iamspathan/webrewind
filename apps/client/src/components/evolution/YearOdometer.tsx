import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface Props {
  year: number;
}

export function YearOdometer({ year }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<number>(year);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!rootRef.current) return;
    const digits = rootRef.current.querySelectorAll<HTMLSpanElement>("[data-digit] > span");
    const prev = String(prevRef.current).padStart(4, "0");
    const next = String(year).padStart(4, "0");

    digits.forEach((el, i) => {
      if (prev[i] === next[i]) return;
      if (reduced) {
        el.textContent = next[i];
        return;
      }
      let swapped = false;
      animate(el, {
        translateY: [
          { to: "-110%", duration: 280, ease: "inQuad" },
          { to: "0%", duration: 380, ease: "outExpo" },
        ],
        onUpdate: (anim) => {
          if (!swapped && anim.progress > 0.5) {
            el.textContent = next[i];
            swapped = true;
          }
        },
      });
    });
    prevRef.current = year;
  }, [year, reduced]);

  const digits = String(year).padStart(4, "0").split("");

  return (
    <div
      ref={rootRef}
      aria-live="polite"
      aria-atomic
      className="flex select-none"
      style={{
        fontFamily: '"IBM Plex Serif", "Source Serif Pro", Georgia, serif',
        fontSize: "clamp(4rem, 9vw, 8.5rem)",
        lineHeight: 1,
        letterSpacing: "-0.04em",
        color: "var(--reel-paper)",
        fontVariantNumeric: "tabular-nums",
        textShadow: "0 2px 60px rgba(246, 197, 106, 0.25)",
      }}
    >
      {digits.map((d, i) => (
        <span
          key={i}
          data-digit
          className="inline-block overflow-hidden"
          style={{ height: "1em" }}
        >
          <span className="inline-block">{d}</span>
        </span>
      ))}
    </div>
  );
}
