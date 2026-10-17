// denext/mobile `pickMedia`: several photos and videos from the library (Camera's
// chooseFromGallery, the FilePicker plugin, a `multiple` file input on the web) and a recorded
// video, driven through faked Capacitor plugins and a fake DOM.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { pickMedia } from "../src/mobile/pickers.ts";
import { type Any, fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";

/** An Error carrying a plugin `code`. */
function pluginError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

/** A fake document whose file inputs choose `files` (or dispatch `cancel` when null). */
function fakeFileDocument(choose: () => File[] | null) {
  const inputs: Any[] = [];
  const doc = {
    body: { appendChild: (el: Any) => (el.attached = true) },
    createElement(tag: string) {
      const listeners = new Map<string, () => void>();
      const el: Any = {
        tag,
        type: "",
        accept: "",
        multiple: false,
        attrs: {} as Record<string, string>,
        style: {},
        files: null,
        attached: false,
        setAttribute: (k: string, v: string) => (el.attrs[k] = v),
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        remove: () => (el.attached = false),
        click() {
          const files = choose();
          queueMicrotask(() => {
            if (files) {
              el.files = files;
              listeners.get("change")?.();
            } else listeners.get("cancel")?.();
          });
        },
      };
      inputs.push(el);
      return el;
    },
  };
  return { doc, inputs };
}

const GALLERY = {
  results: [
    {
      type: 0,
      uri: "file:///var/mobile/tmp/IMG_0001.HEIC",
      webPath: "capacitor://localhost/_capacitor_file_/var/mobile/tmp/IMG_0001.HEIC",
      metadata: { size: 1200, format: "heic", resolution: "4032x3024" },
    },
    {
      type: 1,
      uri: "file:///var/mobile/tmp/clip.mov",
      webPath: "capacitor://localhost/_capacitor_file_/var/mobile/tmp/clip.mov",
      metadata: { size: 9000, format: "mov", duration: 12.5, resolution: "1920x1080" },
    },
    {
      type: 0,
      webPath: "capacitor://localhost/_capacitor_file_/c.jpg",
      metadata: { format: "jpg" },
    },
  ],
};

Deno.test("pickMedia: Camera.chooseFromGallery with the media type, multi-select and limit", async () => {
  const camera = fakePlugin(["chooseFromGallery", "getPhoto"], { chooseFromGallery: GALLERY });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    const picked = await pickMedia({
      mediaTypes: "all",
      multiple: true,
      selectionLimit: 2,
      quality: 70,
    });
    assertEquals(picked, [
      {
        type: "image",
        webPath: "capacitor://localhost/_capacitor_file_/var/mobile/tmp/IMG_0001.HEIC",
        mimeType: "image/heic",
        format: "heic",
        name: "IMG_0001.HEIC",
        size: 1200,
        width: 4032,
        height: 3024,
        path: "file:///var/mobile/tmp/IMG_0001.HEIC",
      },
      {
        type: "video",
        webPath: "capacitor://localhost/_capacitor_file_/var/mobile/tmp/clip.mov",
        mimeType: "video/quicktime",
        format: "mov",
        name: "clip.mov",
        size: 9000,
        width: 1920,
        height: 1080,
        duration: 12.5,
        path: "file:///var/mobile/tmp/clip.mov",
      },
    ], "cut to the selection limit even when the picker returns more");
    await pickMedia({ mediaTypes: "videos" });
    await pickMedia();
  });
  assertEquals(camera.calls, [
    ["chooseFromGallery", {
      mediaType: 2,
      allowMultipleSelection: true,
      limit: 2,
      includeMetadata: true,
      quality: 70,
    }],
    ["chooseFromGallery", { mediaType: 1, allowMultipleSelection: false, includeMetadata: true }],
    ["chooseFromGallery", { mediaType: 0, allowMultipleSelection: false, includeMetadata: true }],
  ]);
});

Deno.test("pickMedia: a cancelled gallery or recording is null; a denial rejects", async () => {
  for (
    const err of [pluginError("x", "OS-PLUG-CAMR-0020"), pluginError("User cancelled photos app")]
  ) {
    const camera = fakePlugin(["chooseFromGallery"], { chooseFromGallery: err });
    await inShell("android", { Camera: camera.plugin }, async () => {
      assertEquals(await pickMedia({ multiple: true }), null);
    });
  }
  const empty = fakePlugin(["chooseFromGallery"], { chooseFromGallery: { results: [] } });
  await inShell("android", { Camera: empty.plugin }, async () => {
    assertEquals(await pickMedia({ multiple: true }), null);
  });
  const recordCancel = fakePlugin(["recordVideo"], {
    recordVideo: pluginError("x", "OS-PLUG-CAMR-0017"),
  });
  await inShell("ios", { Camera: recordCancel.plugin }, async () => {
    assertEquals(await pickMedia({ source: "camera", mediaTypes: "videos" }), null);
  });
  const denied = fakePlugin(["chooseFromGallery"], {
    chooseFromGallery: pluginError("denied", "OS-PLUG-CAMR-0005"),
  });
  await inShell("ios", { Camera: denied.plugin }, async () => {
    await assertRejects(() => pickMedia(), Error, "denied");
  });
  await assertRejects(() => pickMedia({ mediaTypes: "gifs" as Any }), TypeError, "mediaTypes");
  await assertRejects(() => pickMedia({ source: "files" as Any }), TypeError, "unknown source");
});

Deno.test("pickMedia: the camera records a video (recordVideo) or takes a photo (getPhoto)", async () => {
  const camera = fakePlugin(["recordVideo", "getPhoto"], {
    recordVideo: {
      uri: "file:///data/user/0/app/cache/VID_1.mp4",
      webPath: "https://localhost/_capacitor_file_/data/user/0/app/cache/VID_1.mp4",
      metadata: { format: "mp4", duration: 3, size: 400 },
    },
    getPhoto: { webPath: "https://localhost/_capacitor_file_/p.jpg", format: "jpeg" },
  });
  await inShell("android", { Camera: camera.plugin }, async () => {
    assertEquals(await pickMedia({ source: "camera", mediaTypes: "videos", multiple: true }), [{
      type: "video",
      webPath: "https://localhost/_capacitor_file_/data/user/0/app/cache/VID_1.mp4",
      mimeType: "video/mp4",
      format: "mp4",
      name: "VID_1.mp4",
      size: 400,
      duration: 3,
      path: "file:///data/user/0/app/cache/VID_1.mp4",
    }]);
    assertEquals(await pickMedia({ source: "camera", quality: 50 }), [{
      type: "image",
      webPath: "https://localhost/_capacitor_file_/p.jpg",
      mimeType: "image/jpeg",
      format: "jpeg",
    }]);
  });
  assertEquals(camera.calls, [
    ["recordVideo", { includeMetadata: true }],
    ["getPhoto", { resultType: "uri", source: "CAMERA", allowEditing: false, quality: 50 }],
  ]);
});

Deno.test("pickMedia: the FilePicker plugin for ordered picks, and without Camera's gallery", async () => {
  const files = {
    files: [
      {
        name: "b.mp4",
        mimeType: "video/mp4",
        size: 5,
        path: "/tmp/b.mp4",
        duration: 4,
        width: 640,
        height: 360,
      },
      {
        name: "a.png",
        mimeType: "image/png",
        size: 3,
        path: "/tmp/a.png",
        webPath: "capacitor://localhost/_capacitor_file_/tmp/a.png",
      },
    ],
  };
  const picker = fakePlugin(["pickMedia", "pickImages", "pickVideos", "pickFiles"], {
    pickMedia: files,
    pickVideos: { files: [files.files[0]] },
  });
  const camera = fakePlugin(["chooseFromGallery"], { chooseFromGallery: GALLERY });
  const convertFileSrc = (p: string) => `capacitor://localhost/_capacitor_file_${p}`;
  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: { FilePicker: picker.plugin, Camera: camera.plugin },
    convertFileSrc,
  };
  await withGlobals({ Capacitor }, async () => {
    assertEquals(await pickMedia({ mediaTypes: "all", multiple: true, ordered: true }), [
      {
        type: "video",
        webPath: "capacitor://localhost/_capacitor_file_/tmp/b.mp4",
        mimeType: "video/mp4",
        format: "mp4",
        name: "b.mp4",
        size: 5,
        width: 640,
        height: 360,
        duration: 4,
        path: "/tmp/b.mp4",
      },
      {
        type: "image",
        webPath: "capacitor://localhost/_capacitor_file_/tmp/a.png",
        mimeType: "image/png",
        format: "png",
        name: "a.png",
        size: 3,
        path: "/tmp/a.png",
      },
    ]);
  });
  assertEquals(picker.calls, [["pickMedia", { readData: false, limit: 0, ordered: true }]]);
  assertEquals(camera.calls, [], "ordered picks go to the FilePicker plugin");
  // No Camera plugin: videos through FilePicker.pickVideos, one at a time without `multiple`.
  await inShell("android", { FilePicker: picker.plugin }, async () => {
    const [video] = (await pickMedia({ mediaTypes: "videos" }))!;
    assertEquals(video.type, "video");
  });
  assertEquals(picker.calls.at(-1), ["pickVideos", { readData: false, limit: 1 }]);
});

Deno.test("pickMedia: an older Camera plugin picks several images with pickImages", async () => {
  const camera = fakePlugin(["getPhoto", "pickImages"], {
    getPhoto: { webPath: "capacitor://localhost/_capacitor_file_/one.png", format: "PNG" },
    pickImages: {
      photos: [
        {
          webPath: "capacitor://localhost/_capacitor_file_/1.jpeg",
          path: "file:///1.jpeg",
          format: "jpeg",
        },
        { webPath: "capacitor://localhost/_capacitor_file_/2.jpeg", format: "jpeg" },
      ],
    },
  });
  await inShell("ios", { Camera: camera.plugin }, async () => {
    const picked = await pickMedia({ multiple: true, selectionLimit: 5 });
    assertEquals(picked?.map((p) => [p.type, p.webPath, p.mimeType]), [
      ["image", "capacitor://localhost/_capacitor_file_/1.jpeg", "image/jpeg"],
      ["image", "capacitor://localhost/_capacitor_file_/2.jpeg", "image/jpeg"],
    ]);
    // One image: the photo picker (getPhoto).
    assertEquals(await pickMedia({ quality: 60 }), [{
      type: "image",
      webPath: "capacitor://localhost/_capacitor_file_/one.png",
      mimeType: "image/png",
      format: "png",
    }]);
  });
  assertEquals(camera.calls, [
    ["pickImages", { limit: 5 }],
    ["getPhoto", { resultType: "uri", source: "PHOTOS", allowEditing: false, quality: 60 }],
  ]);
});

Deno.test("pickMedia: web input — multiple, accept per media type, cut to the limit; cancel is null", async () => {
  const png = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const mp4 = new File([new Uint8Array([1, 2])], "b.mp4", { type: "video/mp4" });
  const jpg = new File([new Uint8Array([3])], "c.jpg", { type: "image/jpeg" });
  let next: File[] | null = [png, mp4, jpg];
  const { doc, inputs } = fakeFileDocument(() => next);
  await withGlobals({ document: doc }, async () => {
    const picked = await pickMedia({ mediaTypes: "all", multiple: true, selectionLimit: 2 });
    assertEquals(picked?.map((p) => [p.type, p.mimeType, p.format, p.name, p.size]), [
      ["image", "image/png", "png", "a.png", 1],
      ["video", "video/mp4", "mp4", "b.mp4", 2],
    ]);
    assert(picked?.every((p) => p.webPath.startsWith("blob:")));
    assertEquals(picked?.[1].file, mp4);
    for (const p of picked ?? []) URL.revokeObjectURL(p.webPath);
    const [only] = (await pickMedia({ mediaTypes: "videos" }))!;
    URL.revokeObjectURL(only.webPath);
    assertEquals(only.file, png, "a single pick keeps the first file");
    next = [mp4];
    const [recorded] = (await pickMedia({ source: "camera", mediaTypes: "videos" }))!;
    URL.revokeObjectURL(recorded.webPath);
    assertEquals(recorded.type, "video");
    next = null;
    assertEquals(await pickMedia({ multiple: true }), null);
    next = [];
    assertEquals(await pickMedia({ multiple: true }), null, "an empty selection is a cancel");
  });
  assertEquals(inputs.map((i) => [i.accept, i.multiple, i.attrs.capture, i.attached]), [
    ["image/*,video/*", true, undefined, false],
    ["video/*", false, undefined, false],
    ["video/*", false, "environment", false],
    ["image/*", true, undefined, false],
    ["image/*", true, undefined, false],
  ]);
});
