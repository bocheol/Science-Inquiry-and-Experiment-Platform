import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  ...(process.env.SCIENCE_DEV_ALLOWED_ORIGIN
    ? { allowedDevOrigins: [process.env.SCIENCE_DEV_ALLOWED_ORIGIN] }
    : {}),
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
