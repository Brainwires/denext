// A stable shell: its heading must survive a render error in the page segment (the
// error boundary replaces the segment's content, not the whole document).
export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <h1 data-testid="shell">Boundary fixture</h1>
        {children as never}
      </body>
    </html>
  );
}
