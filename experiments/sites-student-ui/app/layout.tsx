import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "과탐실 · 학생 UI 실험판",
  description: "기존 과학탐구실험 플랫폼에 연결하는 별도 학생 화면입니다.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
