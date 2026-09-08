export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Content Collections — denext</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
