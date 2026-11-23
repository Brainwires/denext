// denext/gpui's images (src/gpui/images.ts): JavaScript fetches each unique source once, sends
// IMAGE_DATA with the SET_IMAGE of every node showing it, frees it when the last node lets go, and
// reports a failed fetch to the nodes' onError / onLoadEnd.

import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { hostConfig as hc } from "../src/gpui/host-config.ts";
import { createGpuiContainer } from "../src/gpui/host-config.ts";
import { imageMime } from "../src/gpui/images.ts";
import { fakeWindow, settle } from "./helpers/gpui-fakes.ts";

/** A fetch answering every URL with `bytes` (or `status`), recording the URLs. */
function fakeFetch(status = 200, bytes = [1, 2, 3], type: string | null = "image/png") {
  const urls: string[] = [];
  const fn = (url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(type ? { "content-type": type } : {}),
      arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
    } as unknown as Response);
  };
  return { urls, fetch: fn as typeof fetch };
}

/** A window and container with `fetch`. */
function setup(fetchImpl: typeof fetch, assetBase?: string) {
  const win = fakeWindow();
  const c = createGpuiContainer(win, { fetch: fetchImpl, ...(assetBase ? { assetBase } : {}) });
  hc.resetAfterCommit(c);
  win.take();
  return { win, c };
}

const A = "https://cdn.example/a.png";
const B = "https://cdn.example/b.png";

Deno.test("one fetch per source; IMAGE_DATA once, SET_IMAGE for each node; freed by the last", async () => {
  const f = fakeFetch();
  const { win, c } = setup(f.fetch);
  const one = hc.createInstance("Image", { source: { uri: A } }, c);
  const two = hc.createInstance("Image", { source: [{ uri: A }] }, c);
  hc.appendChildToContainer(c, one);
  hc.appendChildToContainer(c, two);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps().filter((o) => o.op === "SET_IMAGE"), [], "not before the bytes");
  await settle();
  assertEquals(f.urls, [A]);
  assertEquals(win.takeOps(), [
    { op: "IMAGE_DATA", image: 1, mime: "image/png", bytes: [1, 2, 3] },
    { op: "SET_IMAGE", id: one.id, image: 1 },
    { op: "SET_IMAGE", id: two.id, image: 1 },
  ]);
  // A node showing a ready image gets it with its CREATE.
  const three = hc.createInstance("Image", { source: A }, c);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps().at(-1), { op: "SET_IMAGE", id: three.id, image: 1 });
  hc.removeChildFromContainer(c, one);
  hc.removeChild(c.root!, three);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps().map((o) => o.op), ["REMOVE", "DESTROY", "REMOVE", "DESTROY"]);
  hc.removeChildFromContainer(c, two);
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "REMOVE", parent: c.root!.id, child: two.id },
    { op: "DESTROY", id: two.id },
    { op: "IMAGE_FREE", image: 1 },
  ]);
  // Shown again later: fetched again, under a new image id.
  hc.createInstance("Image", { source: A }, c);
  hc.resetAfterCommit(c);
  await settle();
  assertEquals(f.urls, [A, A]);
  assertEquals(win.takeOps().find((o) => o.op === "IMAGE_DATA"), {
    op: "IMAGE_DATA",
    image: 2,
    mime: "image/png",
    bytes: [1, 2, 3],
  });
});

Deno.test("a node whose CREATE is still pending gets its SET_IMAGE in the pending batch", async () => {
  const { win, c } = setup(fakeFetch().fetch);
  const img = hc.createInstance("Image", { source: A }, c);
  await settle(); // the bytes arrive while the commit that creates the node is still rendering
  assertEquals(win.takeOps(), [{
    op: "IMAGE_DATA",
    image: 1,
    mime: "image/png",
    bytes: [1, 2, 3],
  }]);
  hc.resetAfterCommit(c);
  const ops = win.takeOps();
  assertEquals(ops[0], { op: "CREATE", id: img.id, kind: 4 });
  assertEquals(ops.at(-1), { op: "SET_IMAGE", id: img.id, image: 1 });
});

Deno.test("changing or dropping the source points the node away, then frees the old image", async () => {
  const f = fakeFetch();
  const { win, c } = setup(f.fetch);
  const props = { source: A };
  const img = hc.createInstance("Image", props, c);
  hc.resetAfterCommit(c);
  await settle();
  win.take();
  hc.commitUpdate(img, "Image", props, { source: B });
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "SET_IMAGE", id: img.id, image: 0 },
    { op: "IMAGE_FREE", image: 1 },
  ]);
  await settle();
  assertEquals(win.takeOps(), [
    { op: "IMAGE_DATA", image: 2, mime: "image/png", bytes: [1, 2, 3] },
    { op: "SET_IMAGE", id: img.id, image: 2 },
  ]);
  hc.commitUpdate(img, "Image", { source: B }, {});
  hc.resetAfterCommit(c);
  assertEquals(win.takeOps(), [
    { op: "SET_IMAGE", id: img.id, image: 0 },
    { op: "IMAGE_FREE", image: 2 },
  ]);
  assertEquals(f.urls, [A, B]);
});

Deno.test("a source released while it loads is dropped when the bytes arrive", async () => {
  const f = fakeFetch();
  const { win, c } = setup(f.fetch);
  const img = hc.createInstance("Image", { source: A }, c);
  hc.resetAfterCommit(c);
  hc.commitUpdate(img, "Image", { source: A }, { source: null });
  hc.resetAfterCommit(c);
  win.take();
  await settle();
  assertEquals(win.batches.length, 0);
  // Nothing is held for it: showing it again fetches it again.
  hc.createInstance("Image", { source: A }, c);
  assertEquals(f.urls, [A, A]);
});

Deno.test("a failed fetch calls onError then onLoadEnd, now and for later nodes", async () => {
  const seen: unknown[] = [];
  const props = {
    source: A,
    onError: (e: unknown) => seen.push(e),
    onLoadEnd: () => seen.push("end"),
  };
  const { win, c } = setup(fakeFetch(404).fetch);
  const img = hc.createInstance("Image", props, c);
  hc.resetAfterCommit(c);
  await settle();
  assertEquals(seen, [{ nativeEvent: { error: "HTTP 404" }, target: img.id }, "end"]);
  const later = hc.createInstance("Image", props, c);
  await settle();
  assertEquals(seen.slice(2), [{ nativeEvent: { error: "HTTP 404" }, target: later.id }, "end"]);
  assertEquals(win.takeOps().some((o) => o.op === "IMAGE_DATA"), false);
});

Deno.test("a rejected fetch and a throwing onError are reported", async () => {
  const errors: unknown[] = [];
  const win = fakeWindow();
  const c = createGpuiContainer(win, {
    fetch: () => Promise.reject(new TypeError("offline")),
    onError: (e) => void errors.push(e),
  });
  const seen: unknown[] = [];
  hc.createInstance("Image", { source: A, onError: (e: unknown) => seen.push(e) }, c);
  hc.createInstance("Image", {
    source: B,
    onError: () => {
      throw new Error("handler");
    },
  }, c);
  await settle();
  assertEquals((seen[0] as { nativeEvent: { error: string } }).nativeEvent.error, "offline");
  assertEquals((errors[0] as Error).message, "handler");
});

Deno.test("relative sources resolve against assetBase, else the working directory", async () => {
  const f = fakeFetch();
  const { c } = setup(f.fetch, "https://app.example/assets/");
  hc.createInstance("Image", { source: "img/logo.png" }, c);
  hc.createInstance("Image", { source: "http://[" }, c); // not a URL: fetched as given
  hc.createInstance("Image", { source: "" }, c); // no source
  const cwd = setup(f.fetch).c;
  hc.createInstance("Image", { source: { uri: "local.png" } }, cwd);
  await settle();
  assertEquals(f.urls, [
    "https://app.example/assets/img/logo.png",
    "http://[",
    new URL("local.png", toFileUrl(`${Deno.cwd()}/`)).href,
  ]);
});

Deno.test("imageMime: the response's type, else the extension's, else octet-stream", () => {
  assertEquals(imageMime("a.bin", "image/webp; charset=binary"), "image/webp");
  assertEquals(imageMime("https://x/a.JPG?v=2#f", null), "image/jpeg");
  assertEquals(imageMime("a.svg", ""), "image/svg+xml");
  assertEquals(imageMime("a.unknown", undefined), "application/octet-stream");
  assertEquals(imageMime("noext", null), "application/octet-stream");
});
