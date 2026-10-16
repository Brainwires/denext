// The deploy-manifest fixture's root layout (read as text by tests/deploy-manifest.test.ts).
export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
