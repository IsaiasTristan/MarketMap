"use client";

import { useEffect, useState } from "react";

/** Returns `now`, refreshed on an interval so session-proportional charts re-layout. */
export function useSessionClock(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
