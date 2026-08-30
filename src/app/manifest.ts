import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "과탐실 AI 탐구 플랫폼",
    short_name: "과탐실 AI",
    description: "상당고등학교 통합과학 팀 탐구 플랫폼",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfcf8",
    theme_color: "#146b55",
    lang: "ko",
    categories: ["education"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
