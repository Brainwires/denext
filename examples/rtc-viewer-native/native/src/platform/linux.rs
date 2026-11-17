//! Linux: designed, not built yet. Every call reports `Error::UnsupportedPlatform`, so the
//! example runs (its page says the native viewer is unavailable) and the C ABI is the same.
//!
//! The design, slotting into the same surface as `platform/macos`:
//!
//! - **Decode** (`Decoder`): VA-API (`libva`, opened with `dlopen` so the library loads on a host
//!   without it) on the render node (`/dev/dri/renderD128`): `vaCreateConfig` for
//!   `VAProfileH264High` / `VAProfileHEVCMain` / `VAProfileVP9Profile0` / `VAProfileAV1Profile0`
//!   with `VAEntrypointVLD`, surfaces in `VA_RT_FORMAT_YUV420` (NV12). VA-API takes parsed slice
//!   parameters, not a bitstream, so the decoder carries the codec's slice-header parser
//!   (`cros-codecs`' stateless H.264 / H.265 / VP9 / AV1 decoders do exactly this over VA-API,
//!   and are the crate to build on). Low latency: no reorder queue (WebRTC has no B-frames), so
//!   each picture is output as soon as its `vaSyncSurface` returns. `Frame` holds the surface.
//! - **Present** (`Presenter`): `vaExportSurfaceHandle(VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2)`
//!   gives the picture's DMA-BUF planes, imported into Vulkan (`VK_EXT_external_memory_dma_buf` +
//!   `VK_EXT_image_drm_format_modifier`) as a multi-planar `G8_B8R8_2PLANE_420_UNORM` image with a
//!   `VkSamplerYcbcrConversion`: no copy. The window is the app's own (Wayland `xdg_toplevel`
//!   full-screen, or X11 with `_NET_WM_STATE_FULLSCREEN`), its `VkSwapchainKHR` in
//!   `VK_PRESENT_MODE_MAILBOX_KHR` (or `IMMEDIATE`), two images. One draw converts and
//!   letterboxes, as the Metal shader does.
//! - **Measure**: `VK_KHR_present_wait` / `VK_GOOGLE_display_timing` (`actualPresentTime`), or
//!   Wayland's `wp_presentation` feedback, for the per-frame present time; `now()` is
//!   `CLOCK_MONOTONIC`, the clock both report in.

use std::sync::Arc;

use crate::codec::Codec;
use crate::viewer::{Error, PushOutcome, Shared};

/// Seconds on a monotonic clock.
pub fn now() -> f64 {
  use std::sync::OnceLock;
  use std::time::Instant;
  static START: OnceLock<Instant> = OnceLock::new();
  START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn is_main_thread() -> bool {
  false
}

/// A decoded picture (a VA surface, once built).
pub struct Frame {
  pub push_time: f64,
  pub decoded_time: f64,
}

impl Frame {
  pub fn width(&self) -> u32 {
    0
  }
  pub fn height(&self) -> u32 {
    0
  }
}

pub fn inspect(_frame: &Frame) -> (f64, u32) {
  (0.0, 0)
}

pub struct Decoder;

impl Decoder {
  pub fn new(_codec: Codec, _shared: Arc<Shared>) -> Result<Self, Error> {
    Err(Error::UnsupportedPlatform)
  }
  pub fn decode(&mut self, _data: &[u8], _push_time: f64) -> Result<PushOutcome, Error> {
    Err(Error::UnsupportedPlatform)
  }
  pub fn flush(&mut self) {}
}

pub struct Presenter;

impl Presenter {
  pub fn offscreen(_shared: Arc<Shared>, _w: u32, _h: u32) -> Result<Self, Error> {
    Err(Error::UnsupportedPlatform)
  }
  pub fn window(_shared: Arc<Shared>, _display: i32, _fullscreen: bool) -> Result<Self, Error> {
    Err(Error::UnsupportedPlatform)
  }
  pub fn has_window(&self) -> bool {
    false
  }
  pub fn stop(self) {}
  pub fn abandon(self) {}
}
