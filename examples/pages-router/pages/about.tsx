import { Link } from "@denext/pages-router/link";

export default function About() {
  return (
    <main>
      <h1 className="about">About</h1>
      <p>A statically-rendered Pages Router route.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
