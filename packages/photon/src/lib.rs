//! Deno-native wasm bindings for the photon-rs subset denext's image optimizer
//! uses: `PhotonImage` (decode / raw pixels / webp encode), `resize`, and
//! `SamplingFilter`. photon-rs already carries the `#[wasm_bindgen]` annotations,
//! so re-exporting the subset keeps their generated bindings in the emitted glue —
//! producing the same JS API surface as `@cf-wasm/photon`, but built for Deno.

pub use photon_rs::transform::{resize, SamplingFilter};
pub use photon_rs::PhotonImage;
