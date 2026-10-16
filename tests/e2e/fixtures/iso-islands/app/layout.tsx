export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <title>iso-islands fixture</title>
      </head>
      <body>{children as never}</body>
    </html>
  );
}
