import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The M2/M3 test harnesses grew into /talk.
  async redirects() {
    return [
      { source: "/chat", destination: "/talk?mode=chat", permanent: false },
      { source: "/voice", destination: "/talk?mode=voice", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
