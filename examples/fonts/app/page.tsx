// A static page — no client JS. The point is the <head> font CSS the layout emits.

import type { PageProps } from "denext/server";

export default function Home(_props: PageProps) {
  return (
    <main>
      <h1>Fonts</h1>
      <p>
        This page uses the Inter font from `next/font/google`, self-hosted at build.
      </p>
    </main>
  );
}
