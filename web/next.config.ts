import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// One `.env` in the repo root configures both apps (the agent reads it too). Next itself only looks in web/,
// so load the root file here; web/.env* files still work and take precedence. On Vercel there is no file:
// variables come from the project settings.
loadEnvConfig(path.resolve(process.cwd(), ".."));

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
