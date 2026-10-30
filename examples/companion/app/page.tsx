// Loopy's only page: a Server Component that renders the client-side companion.
import { Companion } from "./companion.tsx";

export const metadata = { title: "Loopy" };

export default function Page() {
  return <Companion />;
}
