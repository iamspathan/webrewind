import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export function GrainOverlay() {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 7), 90);
    return () => window.clearInterval(id);
  }, [reduced]);

  const svg = encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' seed='${tick}'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.85'/></svg>`
  );

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] mix-blend-overlay"
      style={{
        opacity: "var(--reel-grain-opacity)",
        backgroundImage: `url("data:image/svg+xml;utf8,${svg}")`,
        backgroundSize: "240px 240px",
      }}
    />
  );
}
