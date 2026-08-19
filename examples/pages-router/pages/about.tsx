import { Link } from "@denext/pages-router/link";
import Head from "@denext/pages-router/head";
import styles from "./about.module.css";

export default function About() {
  return (
    <main>
      <Head>
        <title>About PR</title>
      </Head>
      <h1 className="about">About</h1>
      {
        /* Unique per-route CSS Module — only about.css styles this red. Proves soft
          navigation injects the target route's stylesheet. */
      }
      <span className={styles.tag} data-testid="about-tag">about-only</span>
      <p>A statically-rendered Pages Router route.</p>
      <Link href="/">Home</Link>
    </main>
  );
}
