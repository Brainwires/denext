export default function RootLayout({ children }: { children: unknown }) {
  return <div class="root">{children as never}</div>;
}
