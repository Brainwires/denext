// The viewer. A Server Component that renders the interactive island (app/viewer.tsx); every
// decision about the pipeline is made in the browser, from what its engine has.

import { Viewer } from "./viewer.tsx";

export const metadata = { title: "RTC viewer" };

export default function ViewerPage() {
  return <Viewer />;
}
