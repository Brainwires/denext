export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <h1 data-testid="shell">Fragment refs fixture</h1>
        {children as never}
      </body>
    </html>
  );
}
