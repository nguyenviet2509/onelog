import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "onelog",
  description: "Log investigation assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className="dark">
      <body className="min-h-screen bg-bg text-fg antialiased">
        {children}
      </body>
    </html>
  );
}
