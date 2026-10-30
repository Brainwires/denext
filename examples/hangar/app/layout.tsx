// Root layout: denext supplies <html>/<head>/<body>. The tray shell owns the tray icon and the
// window's panel / full / hidden modes for every page.
import type { LayoutProps } from "denext/server";
import { TrayShell } from "./tray-shell.tsx";

export const metadata = {
  title: "Hangar",
  description: "QEMU disk images and VMs from the tray",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <main className="content">
      <TrayShell />
      {children}
    </main>
  );
}
