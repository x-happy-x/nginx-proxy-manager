import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type TooltipPlacement = "bottom" | "top" | "right" | "left";

type Pos = {
  x: number;
  y: number;
  placement: TooltipPlacement;
};

const GAP = 10;
const VIEWPORT_PAD = 8;
const ORDER: TooltipPlacement[] = ["bottom", "top", "right", "left"];

function overflowAmount(x: number, y: number, width: number, height: number): number {
  const right = x + width;
  const bottom = y + height;
  return (
    Math.max(0, VIEWPORT_PAD - x) +
    Math.max(0, VIEWPORT_PAD - y) +
    Math.max(0, right - (window.innerWidth - VIEWPORT_PAD)) +
    Math.max(0, bottom - (window.innerHeight - VIEWPORT_PAD))
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function useSmartTooltip() {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>({ x: 0, y: 0, placement: "bottom" });

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || !tooltipRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const tip = tooltipRef.current.getBoundingClientRect();

    const attempts: Record<TooltipPlacement, { x: number; y: number }> = {
      bottom: {
        x: anchor.left + anchor.width / 2 - tip.width / 2,
        y: anchor.bottom + GAP,
      },
      top: {
        x: anchor.left + anchor.width / 2 - tip.width / 2,
        y: anchor.top - tip.height - GAP,
      },
      right: {
        x: anchor.right + GAP,
        y: anchor.top + anchor.height / 2 - tip.height / 2,
      },
      left: {
        x: anchor.left - tip.width - GAP,
        y: anchor.top + anchor.height / 2 - tip.height / 2,
      },
    };

    const best = ORDER.reduce<{ placement: TooltipPlacement; score: number; x: number; y: number } | null>((acc, placement) => {
      const candidate = attempts[placement];
      const score = overflowAmount(candidate.x, candidate.y, tip.width, tip.height);
      if (!acc || score < acc.score) {
        return { placement, score, x: candidate.x, y: candidate.y };
      }
      return acc;
    }, null);

    if (!best) return;

    const x = clamp(best.x, VIEWPORT_PAD, window.innerWidth - tip.width - VIEWPORT_PAD);
    const y = clamp(best.y, VIEWPORT_PAD, window.innerHeight - tip.height - VIEWPORT_PAD);
    setPos({ x, y, placement: best.placement });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    const onMove = () => updatePosition();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, updatePosition]);

  return {
    anchorRef,
    tooltipRef,
    open,
    pos,
    openTooltip: () => setOpen(true),
    closeTooltip: () => setOpen(false),
  };
}
