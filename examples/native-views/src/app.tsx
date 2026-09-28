// Native views inside a scrolling VirtualList: two maps (MKMapView on iOS, osmdroid on Android)
// and a video player, each a NativeViewSlot that the page scrolls, clips and covers like any
// other box. Everything else in a row is plain DOM. Off the shell (a desktop browser) each slot
// renders its children, the web fallback.
"use client";
import { useEffect, useState, VirtualList } from "denext";
import { nativePlatform, type NativeViewPlacementOption, NativeViewSlot } from "denext/mobile";
import { probe, startRectProbe } from "./probe.ts";

type Command = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
/** Each slot's command, by its probe name (the probe build asks each for its native frame). */
const commands = new Map<string, Command>();

type Row =
  | { kind: "text"; id: number }
  | {
    kind: "map";
    id: number;
    title: string;
    lat: number;
    lon: number;
    placement: NativeViewPlacementOption;
  }
  | { kind: "video"; id: number };

const VIDEO = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

/** The native rows by position; every other row of the 120 is text. */
const SPECIAL: Record<number, Row> = {
  3: {
    kind: "map",
    id: 3,
    title: "London",
    lat: 51.5074,
    lon: -0.1278,
    placement: "auto",
  },
  12: { kind: "video", id: 12 },
  // Under the WebView: DOM overlays draw above it (the page is transparent there).
  40: {
    kind: "map",
    id: 40,
    title: "Lisbon (under)",
    lat: 38.7223,
    lon: -9.1393,
    placement: "under",
  },
};

function rows(): Row[] {
  return Array.from(
    { length: 120 },
    (_, id) => SPECIAL[id] ?? { kind: "text", id },
  );
}

function MapCard({ row }: { row: Extract<Row, { kind: "map" }> }) {
  const [zoom, setZoom] = useState(12);
  const [region, setRegion] = useState("");
  const [command, setCommand] = useState<
    ((name: string, args?: Record<string, unknown>) => Promise<unknown>) | null
  >(null);
  return (
    <section class="card">
      <h2>{row.title}</h2>
      <NativeViewSlot
        type="map"
        placement={row.placement}
        class="slot"
        data-probe={`map${row.id}`}
        props={{
          latitude: row.lat,
          longitude: row.lon,
          zoom,
          markers: [{
            latitude: row.lat,
            longitude: row.lon,
            title: row.title,
          }],
        }}
        onEvent={(name, data) => {
          probe(`map${row.id}:${name}`, data);
          if (name === "regionChange") {
            const r = data as {
              latitude: number;
              longitude: number;
              zoom: number;
            };
            setRegion(
              `${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)} @ ${r.zoom.toFixed(1)}`,
            );
          }
        }}
        onCommand={(c) => {
          setCommand(() => c);
          if (c) commands.set(`map${row.id}`, c);
          else commands.delete(`map${row.id}`);
        }}
        overlay={
          <button
            type="button"
            class="overlay-button"
            onClick={() =>
              command?.("setRegion", {
                latitude: row.lat,
                longitude: row.lon,
                zoom,
                animated: true,
              })}
          >
            Recenter
          </button>
        }
      >
        <div class="fallback">
          Map of {row.title} (a native map in the iOS / Android app)
        </div>
      </NativeViewSlot>
      <div class="controls">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(2, z - 1))}
        >
          −
        </button>
        <span>zoom {zoom}</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(19, z + 1))}
        >
          +
        </button>
      </div>
      <p class="muted">{region || "Pan the map: its region shows here."}</p>
    </section>
  );
}

function VideoCard() {
  const [status, setStatus] = useState("idle");
  return (
    <section class="card">
      <h2>Video</h2>
      <NativeViewSlot
        type="video"
        class="slot video"
        data-probe="video"
        // Muted autoplay (allowed without a tap); the system controls pause and resume it.
        props={{
          src: VIDEO,
          controls: true,
          muted: true,
          loop: true,
          autoplay: true,
        }}
        onEvent={(name, data) => {
          probe(`video:${name}`, data);
          setStatus(name);
        }}
        onCommand={(c) => c ? commands.set("video", c) : commands.delete("video")}
      >
        <video
          src={VIDEO}
          controls
          muted
          loop
          autoPlay
          playsInline
          class="fallback-video"
        />
      </NativeViewSlot>
      <p class="muted">native: {status}</p>
    </section>
  );
}

function Sheet({ onClose }: { onClose: () => void }) {
  return (
    <div class="backdrop" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>A sheet over the page</h2>
        <p>
          Native views drawn over the WebView hide while the sheet covers them; views under it or
          embedded in it stop taking touches.
        </p>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function App() {
  const [data] = useState(rows);
  const [sheet, setSheet] = useState(false);
  useEffect(() => startRectProbe(commands), []);
  return (
    <main class="app">
      <header class="bar">
        <strong>Native views</strong>
        <span class="muted">{nativePlatform()}</span>
        <button type="button" onClick={() => setSheet(true)}>Open sheet</button>
      </header>
      <VirtualList<Row>
        data={data}
        keyExtractor={(row) => row.id}
        estimatedItemSize={72}
        style={{ flex: "1", minHeight: "0" }}
        renderItem={(row) =>
          row.kind === "map"
            ? <MapCard row={row} />
            : row.kind === "video"
            ? <VideoCard />
            : (
              <div class="text-row">
                Row {row.id}: plain DOM between the native views.
              </div>
            )}
      />
      {sheet && <Sheet onClose={() => setSheet(false)} />}
    </main>
  );
}
