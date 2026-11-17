//! The platform backends. Each provides the same surface, which `viewer.rs` drives:
//!
//! - `now() -> f64`: seconds on the clock the presenter reports present times in;
//! - `is_main_thread() -> bool`;
//! - `Frame`: a decoded picture (`push_time`, `decoded_time`, `width()`, `height()`), `Send`;
//! - `inspect(&Frame) -> (mean_luma, hash)`;
//! - `Decoder::new(codec, Arc<Shared>)`, `decode(&mut self, data, push_time)`, `flush()`: queues
//!   frames and calls `Shared::on_decoded` / `on_decode_error` from its output thread;
//! - `Presenter::window(shared, display, fullscreen)` (UI thread),
//!   `Presenter::offscreen(shared, w, h)`, `stop(self)`, `abandon(self)`, `has_window()`: takes
//!   pictures from `Shared::mailbox` on a render thread and calls `Shared::on_presented`.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
