export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <main data-testid="layout">{children as never}</main>
      </body>
    </html>
  );
}
