import { Link } from "denext";
import { Boom } from "./boom.tsx";

export default function Page() {
  return (
    <main>
      <p data-testid="home">Home</p>
      <Boom />
      <Link href="/gone">go missing</Link>
    </main>
  );
}
