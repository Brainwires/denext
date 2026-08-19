import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext · server actions",
  description:
    "Server Actions on denext: a progressively-enhanced form plus a useActionState / useOptimistic / useFormStatus client island.",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">denext · actions</span>
      </header>
      <main class="content">{children}</main>
      <footer class="foot">
        "use server" · same-origin CSRF check · progressive enhancement
      </footer>
    </div>
  );
}
