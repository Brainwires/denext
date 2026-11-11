// An Edge Function that allocates until its worker's heap cap stops it: 8 MB a step, so a
// 16 MB cap is crossed in a few steps however slow the run.
Deno.serve(() => {
  const hoard: number[][] = [];
  for (;;) hoard.push(new Array(1 << 20).fill(hoard.length));
});
