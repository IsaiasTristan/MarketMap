"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface DeferUntilVisibleProps {
  children: ReactNode;
  /**
   * Placeholder min-height (px) reserved before the content mounts so the
   * scroll position does not jump when the real content appears.
   */
  minHeight?: number;
  /** IntersectionObserver rootMargin — mount slightly before entering view. */
  rootMargin?: string;
  /** Optional placeholder shown while off-screen (defaults to an empty box). */
  placeholder?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/**
 * Renders nothing (just a reserved-height placeholder) until the wrapper
 * scrolls into view, then mounts `children` and keeps them mounted. Used to
 * defer expensive sub-trees — Recharts containers, polling queries — so they
 * are not all instantiated on first paint of a long page.
 */
export function DeferUntilVisible({
  children,
  minHeight = 120,
  rootMargin = "200px",
  placeholder,
  style,
  className,
}: DeferUntilVisibleProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible, rootMargin]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ minHeight: visible ? undefined : minHeight, ...style }}
    >
      {visible ? children : (placeholder ?? null)}
    </div>
  );
}
