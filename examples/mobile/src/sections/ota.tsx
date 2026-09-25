// Over-the-air UI updates: check a server (here `deno task ota:serve` on your machine) for
// a newer export, download it, then switch to it.
import { useState } from "denext";
import { applyUiUpdate, otaReset, otaStatus, prepareUiUpdate } from "denext/mobile";
import { Button, Output, Section, useRun } from "../ui.tsx";

export function Ota() {
  const [baseUrl, setBaseUrl] = useState("http://192.168.1.10:8787");
  const [ready, setReady] = useState<string | null>(null);
  const [out, run] = useRun();
  const check = () =>
    run(async () => {
      // Downloads and verifies a newer UI without switching to it ("ready"), or reports
      // "current" / "error" / "unsupported" (on the web).
      const result = await prepareUiUpdate({ baseUrl });
      setReady(result.kind === "ready" ? result.version : null);
      return result;
    });
  return (
    <Section
      title="Over-the-air update"
      note="Run `deno task ota:serve` on your machine, put its LAN URL here, then Check. Apply reloads into the new UI."
    >
      <input
        value={baseUrl}
        onInput={(e) => setBaseUrl(e.currentTarget.value)}
      />
      <div class="row">
        <Button label="Status" onClick={() => run(otaStatus)} />
        <Button label="Check" onClick={check} />
        {ready && (
          <Button
            label={`Apply ${ready.slice(0, 8)}`}
            onClick={() => run(() => applyUiUpdate(ready))}
          />
        )}
        <Button
          label="Reset"
          onClick={() => run(() => otaReset().then(() => "reset to the bundled UI"))}
        />
      </div>
      <Output value={out} />
    </Section>
  );
}
