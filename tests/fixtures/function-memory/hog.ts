// An Edge Function that allocates until its worker's heap cap stops it: 8 MB a step, so a
// 16 MB cap is crossed in a few steps however slow the run. A heap past 256 MB means no cap is in
// force (a heap size in DENO_V8_FLAGS overrides the worker's own): it answers 507 with how far it
// got then, so the test fails at once instead of the allocation eating the host's memory.
Deno.serve(() => {
  const hoard: number[][] = [];
  while (Deno.memoryUsage().heapUsed < 256 << 20) hoard.push(new Array(1 << 20).fill(hoard.length));
  return Response.json({ code: "NOT_CAPPED", heapUsedMb: Deno.memoryUsage().heapUsed >> 20 }, {
    status: 507,
  });
});
