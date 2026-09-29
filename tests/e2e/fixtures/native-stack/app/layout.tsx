export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children as never}</body>
    </html>
  );
}
