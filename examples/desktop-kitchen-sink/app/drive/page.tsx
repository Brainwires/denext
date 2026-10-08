// The drive mode's page: the manual checks run from a command queue instead of a person (see
// `protocol.ts` for the folder layout and `e2e/drive.ts` for the command-line driver). Home loads
// it when the app was launched in drive mode; opened otherwise, it says drive mode is off.
import { DrivePanel } from "./drive-panel.tsx";

export default function Drive() {
  return (
    <section>
      <h1 data-kitchen-page="drive">Drive mode</h1>
      <p>
        Commands come from the drive folder's <code>queue/</code>; answers go to{" "}
        <code>results/</code> and events to <code>events.jsonl</code>. Drive it with{" "}
        <code>deno task drive</code>. <a href="/" id="drive-to-home">Back to the kitchen sink</a>
      </p>
      <DrivePanel />
    </section>
  );
}
