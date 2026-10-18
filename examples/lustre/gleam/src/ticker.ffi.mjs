// fallow-ignore-file unused-file -- imported by the compiled Gleam (ticker.gleam's @external)
// The ticker's timer: `callback` every `ms` milliseconds. Nothing cancels it; once the app stops,
// what it dispatches is ignored.
export function every(ms, callback) {
  setInterval(() => callback(), ms);
}
