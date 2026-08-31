export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>denext + Effect</title>
      </head>
      <body
        style={{ fontFamily: "system-ui", maxWidth: 640, margin: "3rem auto" }}
      >
        {children}
      </body>
    </html>
  );
}
