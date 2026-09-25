// App extensions: the "Status" home-screen widget (configurable on iOS 17+ with a `mode`
// of compact | detailed) and the "Build" Live Activity (iOS 16.1+).
import { useState } from "denext";
import {
  endLiveActivity,
  liveActivityPushToken,
  liveActivityPushToStartToken,
  reloadWidgets,
  setWidgetData,
  startLiveActivity,
  updateLiveActivity,
} from "denext/mobile";
import { Button, Output, Section, useRun } from "../ui.tsx";

function Widget() {
  const [text, setText] = useState("All systems go");
  const [mode, setMode] = useState("compact");
  const [out, run] = useRun();
  // Stored without params: what every widget shows unless its mode has its own snapshot.
  const saveDefault = () =>
    setWidgetData("Status", { title: "Status", body: text }).then(() =>
      "saved the default snapshot"
    );
  // Stored for one mode: widgets the user configured with that mode show this one.
  const saveForMode = () =>
    setWidgetData("Status", { title: `Status (${mode})`, body: text }, {
      params: { mode },
    })
      .then(() => `saved the ${mode} snapshot`);
  return (
    <Section
      title="Widget: Status"
      note="Add the widget to the home screen (long-press the widget to pick its mode on iOS 17+). Android widgets show the default snapshot."
    >
      <input value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="row">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value)}>
          <option value="compact">compact</option>
          <option value="detailed">detailed</option>
        </select>
        <Button label="Save default" onClick={() => run(saveDefault)} />
        <Button label="Save for mode" onClick={() => run(saveForMode)} />
        <Button
          label="Reload widgets"
          onClick={() => run(() => reloadWidgets("Status").then(() => "reloaded"))}
        />
      </div>
      <Output value={out} />
    </Section>
  );
}

function LiveActivity() {
  const [id, setId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [out, run] = useRun();
  const start = () =>
    run(async () => {
      // push: true asks ActivityKit for a push token (the app has the push entitlement).
      const started = await startLiveActivity(
        "Build",
        { project: "denext" },
        { title: "Build queued", body: "Waiting for a runner", progress: 0 },
        { push: true },
      );
      setId(started);
      setProgress(0);
      return { id: started };
    });
  const update = () =>
    run(async () => {
      const next = Math.min(progress + 0.25, 1);
      await updateLiveActivity(id!, {
        title: "Building",
        body: `${next * 100}% done`,
        progress: next,
      });
      setProgress(next);
      return `progress ${next}`;
    });
  const end = () =>
    run(async () => {
      await endLiveActivity(id!, {
        state: { title: "Build done", body: "All green", progress: 1 },
      });
      setId(null);
      return "ended";
    });
  return (
    <Section
      title="Live Activity: Build"
      note="Lock Screen and Dynamic Island (iOS 16.1+; push-to-start 17.2+)."
    >
      <div class="row">
        <Button label="Start" onClick={start} />
        {id && <Button label="Update +25%" onClick={update} />}
        {id && <Button label="End" onClick={end} />}
        {id && (
          <Button
            label="Push token"
            onClick={() => run(() => liveActivityPushToken(id))}
          />
        )}
        <Button
          label="Push-to-start token"
          onClick={() => run(liveActivityPushToStartToken)}
        />
      </div>
      <Output value={out} />
    </Section>
  );
}

export function IosExtras() {
  return (
    <>
      <Widget />
      <LiveActivity />
    </>
  );
}
