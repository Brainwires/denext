import { notFound } from "denext";

// Calls notFound() during render → the nearest not-found.tsx renders with a 404.
export default function Gone() {
  notFound();
  return null;
}
