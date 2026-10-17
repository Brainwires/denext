// dangerouslySetInnerHTML across hydration (tests/e2e/raw-html.e2e.test.ts): every route renders
// `RAW` into a host and hydrates; the server's parsed nodes must be the ones left afterwards.
export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <title>raw-html fixture</title>
      </head>
      <body>
        <main>{children as never}</main>
      </body>
    </html>
  );
}
