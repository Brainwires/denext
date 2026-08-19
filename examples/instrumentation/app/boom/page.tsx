// A Server Component that throws during render. denext reports it to
// instrumentation.ts's `onRequestError` (routeType "render", routePath "/boom",
// renderSource "server-rendering") and returns a redacted 500.

export const dynamic = "force-dynamic";

export default function Boom() {
  throw new Error("intentional render error (for onRequestError)");
}
