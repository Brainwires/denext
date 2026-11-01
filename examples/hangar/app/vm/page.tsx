// A VM's details (the VM's id is the `?id=` query, so the static export needs one page).
import { Suspense } from "denext";
import { VmDetails } from "./vm-details.tsx";
import { windowTitle } from "../../lib/tray.ts";

// The page's title is its window's title (the system WebView keeps them in step).
export const metadata = { title: windowTitle("/vm") };

export default function VmPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <VmDetails />
    </Suspense>
  );
}
