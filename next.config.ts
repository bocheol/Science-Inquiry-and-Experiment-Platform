import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["xlsx", "cfb", "fflate", "fast-xml-parser", "pdf-parse", "@napi-rs/canvas"],
  // The upload worker loads SheetJS through native require, outside Next's bundle.
  outputFileTracingIncludes: {
    "/api/teacher/roster": ["./node_modules/xlsx/**/*"],
    "/api/records/**/*": [
      "./node_modules/cfb/**/*", "./node_modules/fflate/**/*", "./node_modules/fast-xml-parser/**/*", "./node_modules/pdf-parse/**/*",
      "./node_modules/.pnpm/pdfjs-dist*/node_modules/pdfjs-dist/**/*.{js,mjs,json,wasm,pfb,bcmap}",
      "./node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/**/*.{js,json}",
      "./node_modules/.pnpm/@napi-rs+canvas-linux-*/node_modules/@napi-rs/canvas-linux-*/*.{node,json}",
    ],
  },
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
      { source: "/records/:path*", headers: privateNoStore },
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
