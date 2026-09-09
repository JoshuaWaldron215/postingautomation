import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: ["@synthos/core"],
  serverExternalPackages: ["postgres", "ffmpeg-static", "ffprobe-static"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
};

export default nextConfig;
