import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Synthos posting", template: "%s · Synthos posting" },
  description: "Instagram Reels posting dashboard for MAP Agency.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f2ec" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
