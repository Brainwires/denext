// An async segment: its server work takes long enough that the loading.tsx fallback is
// observable during a client navigation before the content replaces it.
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default async function Slow() {
  await delay(600);
  return <p data-testid="slow">Slow page ready</p>;
}
