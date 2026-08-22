// A trivial module worker: doubles the number it receives.
self.onmessage = (e: MessageEvent) => {
  (self as unknown as Worker).postMessage((e.data as number) * 2);
};
