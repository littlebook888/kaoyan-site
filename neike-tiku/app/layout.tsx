import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "天天师兄学成选择题刷题系统",
  description: "基于内科、病理、外科、生理与生化讲义整理的交互式复习题库，含讲义校对与对应页图。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
