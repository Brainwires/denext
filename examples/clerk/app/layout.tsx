// The root layout, as in Clerk's Next.js quickstart: `<ClerkProvider>` from `@clerk/nextjs`
// around the app, the same component on the web, in the Deno Desktop window and in the
// Capacitor shell (see README → "One provider everywhere"). Without keys it renders the setup
// screen instead, so a fresh clone explains itself rather than crashing.
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { hasPublishableKey } from "../lib/clerk-env.ts";
import { Header } from "./header.tsx";
import { SetupScreen } from "./setup-screen.tsx";
import "./globals.css";

export const metadata = {
  title: "denext + Clerk",
  description: "Clerk sign-in on the web, Deno Desktop and Capacitor, from one denext app.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  if (!hasPublishableKey()) {
    return (
      <html lang="en">
        <body>
          <SetupScreen />
        </body>
      </html>
    );
  }
  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <Header />
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
