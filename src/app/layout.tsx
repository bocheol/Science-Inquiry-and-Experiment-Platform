import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/toast-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "과탐실 | AI 탐구 플랫폼",
  description: "고등학교 통합과학 팀별 탐구 플랫폼",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "과탐실 AI",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#146b55",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
