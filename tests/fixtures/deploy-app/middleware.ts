// Root middleware with a literal matcher.
export function middleware(_request: Request): Response | undefined {
  return undefined;
}
export const config = { matcher: ["/account/:path*", "/api/:path*"] };
