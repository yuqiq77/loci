import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
  ],
  devIndicators: false,
  output: "standalone",
};

export default nextConfig;
