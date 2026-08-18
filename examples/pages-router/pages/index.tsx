import { useState } from "@denext/denext";
import { Link } from "@denext/pages-router/link";
import Head from "@denext/pages-router/head";
import styles from "./index.module.css";

// The counter proves hydration (state + event handlers); the links prove soft nav.
export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <Head>
        <title>Home PR</title>
        <meta name="description" content="home-desc" />
      </Head>
      <h1 className="home">Home</h1>
      <span className={styles.badge} data-testid="badge">CSS Module</span>
      <button type="button" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </button>
      <nav>
        <Link href="/about">About</Link>
        <Link href="/blog/hello">Post</Link>
      </nav>
    </main>
  );
}
