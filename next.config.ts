import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Keep recently-visited routes compiled in dev so switching among the ~7
   *  module tabs doesn't trigger a recompile every time (the prior 2-page /
   *  60s buffer evicted tabs faster than they were revisited). */
  onDemandEntries: {
    maxInactiveAge: 300_000,
    pagesBufferLength: 8,
  },
  /** Hosts allowed to load dev assets (HMR, _next/*) over a non-localhost origin. */
  allowedDevOrigins: ["dev.itmarketmap.com"],
  /** Production builds are gated on `tsc --noEmit` + tests, not ESLint. Pre-existing
   *  lint debt (unused-var warnings, etc.) must not block `next build`. */
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
