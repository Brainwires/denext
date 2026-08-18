import { useState } from "@denext/denext";
import { Link } from "@denext/pages-router/link";

// The counter proves hydration (state + event handlers); the links prove soft nav.
export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1 className="home">Home</h1>
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
