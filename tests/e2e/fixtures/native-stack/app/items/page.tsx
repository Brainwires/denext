import { Link } from "denext";
import { Counter } from "./counter.tsx";

export const screenOptions = { title: "Items" };

export default function Items() {
  const rows = Array.from({ length: 60 }, (_, i) => i + 1);
  return (
    <div data-testid="list">
      <Counter />
      {rows.map((i) => (
        <p key={i} style={{ height: 40, margin: 0 }}>
          <Link href={`/items/${i}`}>Item {i}</Link>
        </p>
      ))}
    </div>
  );
}
