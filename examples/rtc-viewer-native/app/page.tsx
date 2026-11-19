// The control panel. The video is not here: it has a native window of its own. This page only
// steers it (open / hide) and reads its stats, through the `rtcviewer` desktop extension.
import { Controls } from "./controls.tsx";

export default function Home() {
  return (
    <>
      <h1>RTC Viewer (native)</h1>
      <p className="lede">
        WebRTC received in the app's Deno process, decoded in hardware and drawn by native code. No
        decoded picture passes through JavaScript.
      </p>
      <Controls />
    </>
  );
}
