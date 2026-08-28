import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "과탐실 | AI 탐구 플랫폼",
  description: "고등학교 통합과학 팀별 탐구 플랫폼",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

