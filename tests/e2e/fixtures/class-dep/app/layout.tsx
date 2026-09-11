export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <h1 data-testid="shell">Class-in-a-dependency fixture</h1>
        {children as never}
      </body>
    </html>
  );
}
