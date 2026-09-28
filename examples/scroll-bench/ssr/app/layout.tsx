import type { LayoutProps } from "denext/server";
import { SSR_CSS } from "../components/ssr-css.ts";

export const metadata = {
  title: "denext scroll bench (server-rendered)",
  description: "Server-rendered lists (plain HTML, islands, resumable) vs VirtualList islands.",
  head: `<style>${SSR_CSS}</style>`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
