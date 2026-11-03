// The panel at the tray icon (`desktop.tray.panel.url`): the same VM list as the library, laid out
// compactly.
import { Panel } from "../panel.tsx";
import { PanelMode } from "./panel-mode.tsx";

export default function PanelPage() {
  return (
    <>
      <PanelMode />
      <Panel />
    </>
  );
}
