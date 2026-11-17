//! rtcviewer: hardware video decode and presentation for denext's `rtc-viewer-native` example,
//! behind a C ABI (`ffi.rs`) that the app's Deno process drives through `Deno.dlopen`.
//!
//! JavaScript hands over ENCODED frames (a few kilobytes each) and asks for stats; the pictures
//! never leave native code. The platform backends:
//!
//! - macOS (`platform/macos`): VideoToolbox → IOSurface `CVPixelBuffer` → Metal → `CAMetalLayer`.
//! - Windows (`platform/windows.rs`): designed, not built: Media Foundation / D3D11 → DXGI flip.
//! - Linux (`platform/linux.rs`): designed, not built: VA-API → DMA-BUF → Vulkan.

pub mod annexb;
pub mod codec;
pub mod color;
pub mod ffi;
pub mod mailbox;
mod platform;
pub mod stats;
pub mod viewer;
pub mod vp9;

pub use platform::now;
