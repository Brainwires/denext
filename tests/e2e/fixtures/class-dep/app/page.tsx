import { Widget } from "./widget.tsx";

// A server page whose only class components come from the "@acme/ui" dependency.
export default function Page() {
  return (
    <main>
      <Widget />
      <a href="/plain">plain</a>
    </main>
  );
}
