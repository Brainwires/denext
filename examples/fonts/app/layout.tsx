// Root layout that applies a Google font via `next/font/google`. `denext build`
// self-hosts it: the font's CSS + files are downloaded and served from
// `/_denext/fonts`, so the browser never requests them from Google. (In dev, or if
// the build can't reach Google, it falls back to a runtime <link>.)

import { Inter } from "next/font/google";
import type { LayoutProps } from "denext/server";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-inter",
});

export const metadata = {
  title: "denext — fonts example",
  description: "next/font/google, self-hosted at build",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class={inter.className} style={inter.style}>
      {children}
    </div>
  );
}
