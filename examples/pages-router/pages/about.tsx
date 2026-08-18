import { Link } from "@denext/pages-router/link";
import Head from "@denext/pages-router/head";

export default function About() {
  return (
    <main>
      <Head>
        <title>About PR</title>
      </Head>
      <h1 className="about">About</h1>
      <p>A statically-rendered Pages Router route.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
