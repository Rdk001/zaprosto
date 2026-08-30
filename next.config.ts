import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "16kb" } },
};
export default nextConfig;
