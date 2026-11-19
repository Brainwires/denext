// The RTCRtpScriptTransform worker (lib/pipeline/tap.ts starts it): it sees each encoded frame the
// receiver gets, posts a copy of its bytes to the page (which decodes it with WebCodecs), and
// passes the frame on to the engine's own decoder unless the page asked it not to.
// Plain JavaScript in public/, served as is: a worker script needs no bundling.

/** @type {{ sendKeyFrameRequest?: () => Promise<void> } | null} */
let transformer = null;

self.onrtctransform = (event) => {
  transformer = event.transformer;
  const { passthrough = true } = transformer.options ?? {};
  const tap = new TransformStream({
    transform(frame, controller) {
      const meta = frame.getMetadata();
      const data = frame.data.slice(0);
      self.postMessage({
        type: "frame",
        data,
        key: frame.type === "key",
        mimeType: meta.mimeType ?? null,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      }, [data]);
      if (passthrough) controller.enqueue(frame);
    },
  });
  transformer.readable.pipeThrough(tap).pipeTo(transformer.writable).catch(
    () => {},
  );
};

self.onmessage = (event) => {
  if (event.data?.type === "keyframe") {
    transformer?.sendKeyFrameRequest?.().catch(() => {});
  }
};
