// Where the app's API lives. On the web and in the desktop window (whose /api/* is proxied) that is
// this origin. A Capacitor build serves its pages from the app itself (capacitor://localhost,
// https://localhost), so its API calls go to NEXT_PUBLIC_CLERK_API_ORIGIN (the server, e.g. your
// Mac's https://<name>.ts.net), set when the app is exported; the server's `cors` lets them in.
import { runtimePlatform } from "denext/mobile";

/** `path` on the API's origin. */
export function apiUrl(path: string): string {
  const platform = runtimePlatform();
  const origin = platform === "ios" || platform === "android"
    ? process.env.NEXT_PUBLIC_CLERK_API_ORIGIN
    : undefined;
  return origin ? new URL(path, origin).href : path;
}
