// A VM's details (the VM's id is the `?id=` query, so the static export needs one page).
import { Suspense } from "denext";
import { VmDetails } from "./vm-details.tsx";

export default function VmPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <VmDetails />
    </Suspense>
  );
}
