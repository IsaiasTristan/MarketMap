import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Drop idle compiled routes sooner in dev to limit RAM when many tabs are visited. */
  onDemandEntries: {
    maxInactiveAge: 60_000,
    pagesBufferLength: 2,
  },
};

export default nextConfig;
