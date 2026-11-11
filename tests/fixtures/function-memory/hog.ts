// An Edge Function that allocates until its worker's heap cap stops it.
Deno.serve(() => {
  const hoard: number[][] = [];
  for (;;) hoard.push(new Array(1 << 16).fill(hoard.length));
});
