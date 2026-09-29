// Server-side state the action bumps, so a refresh re-renders with CHANGED server output.
let hits = 0;
export const readHits = (): number => hits;
export const bumpHits = (): void => {
  hits++;
};
