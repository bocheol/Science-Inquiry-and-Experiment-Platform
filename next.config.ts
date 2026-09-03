import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    const privateNoStore = [
      {
        key: "Cache-Control",
        value: "private, no-store, max-age=0, must-revalidate",
      },
    ];

    return [
      { source: "/", headers: privateNoStore },
      { source: "/login", headers: privateNoStore },
      { source: "/inquiry/:path*", headers: privateNoStore },
      { source: "/teacher/:path*", headers: privateNoStore },
      { source: "/change-password", headers: privateNoStore },
      { source: "/api/:path*", headers: privateNoStore },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
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
