"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Observed content width of a container element (height is fixed by the chart).
 * Returns a CALLBACK ref so measurement starts even when the container mounts
 * late (e.g. after a loading state) — a useRef+useEffect pair would observe
 * nothing in that case.
 */
export function useMeasure<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: T | null) => setEl(node), []);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, width];
}
