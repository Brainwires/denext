//! Windows: designed, not built yet. Every call reports `Error::UnsupportedPlatform`, so the
//! example runs (its page says the native viewer is unavailable) and the C ABI is the same.
//!
//! The design, slotting into the same surface as `platform/macos`:
//!
//! - **Decode** (`Decoder`): a Media Foundation H.264 / HEVC / VP9 / AV1 decoder MFT
//!   (`MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER)`),
//!   made D3D-aware with an `IMFDXGIDeviceManager` over the presenter's `ID3D11Device`
//!   (`MFT_MESSAGE_SET_D3D_MANAGER`), `CODECAPI_AVLowLatencyMode = TRUE`, output type NV12. Annex
//!   B goes in as it is (Microsoft's decoders take start codes; `crate::annexb` still finds key
//!   frames and parameter-set changes). The MFT is asynchronous (`METransformHaveOutput`); each
//!   output sample's `IMFDXGIBuffer` is an `ID3D11Texture2D` array slice: the `Frame`, holding the
//!   sample (its texture stays the decoder's until released).
//! - **Present** (`Presenter`): a Win32 window (its own, on the UI thread through `rtcv_main`;
//!   `WS_POPUP` covering the monitor's rect for full-screen, which DWM promotes to independent
//!   flip) with a DXGI flip-model swap chain (`DXGI_SWAP_EFFECT_FLIP_DISCARD`, 2 buffers,
//!   `DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT`, `SetMaximumFrameLatency(1)`,
//!   `ALLOW_TEARING` with `Present(0, DXGI_PRESENT_ALLOW_TEARING)` when supported). The render
//!   thread converts NV12 → RGB with `ID3D11VideoProcessor::VideoProcessorBlt` straight into the
//!   back buffer (the fixed-function path, aspect-fit by its output rect), then presents.
//! - **Measure**: `IDXGISwapChain::GetFrameStatistics` gives each present's `SyncQPCTime`, the
//!   counterpart of `MTLDrawable.presentedTime`; `now()` is `QueryPerformanceCounter`.

use std::sync::Arc;

use crate::codec::Codec;
use crate::viewer::{Error, PushOutcome, Shared};

/// Seconds on the performance counter (what `GetFrameStatistics` reports in).
pub fn now() -> f64 {
  use std::sync::OnceLock;
  use std::time::Instant;
  static START: OnceLock<Instant> = OnceLock::new();
  START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

pub fn is_main_thread() -> bool {
  false
}

/// A decoded picture (an NV12 `ID3D11Texture2D` slice, once built).
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
