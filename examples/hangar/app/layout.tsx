// Root layout: denext supplies <html>/<head>/<body>. The main window's close button hides it
// (close-to-tray); the tray and the windows are driven from the app's process (desktop.ts).
import type { LayoutProps } from "denext/server";
import { CloseToTray } from "./close-to-tray.tsx";

export const metadata = {
  title: "Hangar",
  description: "QEMU disk images and VMs from the tray",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <main className="content">
      <CloseToTray />
      {children}
    </main>
  );
}
