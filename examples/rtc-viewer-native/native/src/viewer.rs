//! The viewer: one decoder, at most one presenter, and the state the decoder's output thread, the
//! presenter's render thread and the C ABI share. Platform-neutral; `crate::platform` does the
//! decoding and drawing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::codec::Codec;
use crate::mailbox::Mailbox;
use crate::platform::{self, Decoder, Frame, Presenter};
use crate::stats::Stats;

/// `rtcv_create` flag: inspect every decoded picture on the CPU (mean luma and a hash, in the
/// stats). For tests and diagnostics: it reads the whole picture back.
pub const FLAG_INSPECT: u32 = 1;

/// What went wrong, as the C ABI's negative codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
  /// A null pointer, an empty frame, a bad size.
  BadArgument,
  /// The codec has no decoder on this platform.
  UnsupportedCodec,
  /// This platform has no backend yet.
  UnsupportedPlatform,
  /// A platform call failed with this code (an `OSStatus` on macOS).
  Platform(i32),
  /// A window operation off the UI thread.
  NotMainThread,
  /// `open` while a presenter runs.
  AlreadyOpen,
  /// No GPU, or no display with that index.
  NoDevice,
}

impl Error {
  /// The C ABI code.
  pub fn code(self) -> i32 {
    match self {
      Self::BadArgument => -1,
      Self::UnsupportedCodec => -2,
      Self::UnsupportedPlatform => -3,
      Self::Platform(_) => -4,
      Self::NotMainThread => -5,
      Self::AlreadyOpen => -6,
      Self::NoDevice => -7,
    }
  }
}

/// What `push` did with a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
  /// Handed to the decoder.
  Queued = 0,
  /// Dropped: no key frame yet to start from.
  WaitingForKeyFrame = 1,
}

/// The state the decoder's callback, the render thread and the ABI share.
#[derive(Default)]
pub struct Shared {
  stats: Mutex<Stats>,
  /// Decoded → presenter: newest wins.
  pub mailbox: Mailbox<Frame>,
  presenting: AtomicBool,
  inspect: bool,
}

impl Shared {
  pub fn lock_stats(&self) -> MutexGuard<'_, Stats> {
    self.stats.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// A picture came out of the decoder (on the decoder's thread).
  pub fn on_decoded(&self, frame: Frame) {
    let inspected = self.inspect.then(|| platform::inspect(&frame));
    {
      let mut stats = self.lock_stats();
      stats.decoded += 1;
      stats.decode.record(frame.decoded_time - frame.push_time);
      stats.width = frame.width();
      stats.height = frame.height();
      if let Some((mean, hash)) = inspected {
        stats.luma_mean = mean;
        stats.luma_hash = hash;
      }
    }
    if self.presenting.load(Ordering::Acquire) && self.mailbox.put(frame) {
      self.lock_stats().dropped += 1;
    }
  }

  /// The decoder failed a frame.
  pub fn on_decode_error(&self, status: i32) {
    let mut stats = self.lock_stats();
    stats.decode_errors += 1;
    if status != 0 {
      stats.last_status = status;
    }
  }

  /// A picture reached the screen (or the offscreen target) at `shown` (platform clock).
  pub fn on_presented(&self, push_time: f64, decoded_time: f64, shown: f64) {
    let mut stats = self.lock_stats();
    stats.presented += 1;
    stats.present.record(shown - decoded_time);
    stats.total.record(shown - push_time);
  }

  /// A picture was presented but its drawable reported no display time (`at`: when the GPU
  /// finished it, the best time known).
  pub fn on_presented_untimed(&self, push_time: f64, decoded_time: f64, at: f64) {
    let mut stats = self.lock_stats();
    stats.presented += 1;
    stats.presented_untimed += 1;
    stats.present.record(at - decoded_time);
    stats.total.record(at - push_time);
  }

  /// The compositor dropped a picture we presented.
  pub fn on_present_dropped(&self) {
    self.lock_stats().dropped += 1;
  }

  /// Marks the state as presenting and opens the mailbox (a presenter calls it before starting
  /// its render thread).
  pub fn begin_presenting(&self) {
    self.mailbox.reopen();
    self.presenting.store(true, Ordering::Release);
  }

  /// The reverse of [`Shared::begin_presenting`]: the render thread's `take` then fails.
  pub fn end_presenting(&self) {
    self.presenting.store(false, Ordering::Release);
    self.mailbox.close();
  }

  pub fn set_window_open(&self, open: bool) {
    self.lock_stats().window_open = open;
  }
}

/// A pending window operation for the UI thread (`rtcv_main`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainOp {
  Open { display: i32, fullscreen: bool },
  Close,
}

/// The viewer behind the C ABI's handle.
pub struct Viewer {
  shared: Arc<Shared>,
  decoder: Mutex<(Codec, Decoder)>,
  presenter: Mutex<Option<Presenter>>,
  pending: Mutex<Option<MainOp>>,
}

// SAFETY: the only member that is not thread-safe by itself is a presenter's AppKit window, which
// is created and closed only in `run_main` on the UI thread, and left alone (`abandon`) when the
// viewer is dropped elsewhere. Everything else is behind a mutex or atomic.
unsafe impl Send for Viewer {}
// SAFETY: as above.
unsafe impl Sync for Viewer {}

impl Viewer {
  /// A viewer for `codec` with `flags` ([`FLAG_INSPECT`]).
  pub fn new(codec: Codec, flags: u32) -> Result<Self, Error> {
    let shared = Arc::new(Shared {
      inspect: flags & FLAG_INSPECT != 0,
      ..Default::default()
    });
    shared.mailbox.close();
    let decoder = Decoder::new(codec, shared.clone())?;
    Ok(Self {
      shared,
      decoder: Mutex::new((codec, decoder)),
      presenter: Mutex::new(None),
      pending: Mutex::new(None),
    })
  }

  /// Switches the decoder to `codec` (a new stream negotiated another one), keeping the window.
  /// A no-op for the current codec.
  pub fn set_codec(&self, codec: Codec) -> Result<(), Error> {
    let mut slot = self.decoder.lock().unwrap_or_else(|e| e.into_inner());
    if slot.0 != codec {
      *slot = (codec, Decoder::new(codec, self.shared.clone())?);
    }
    Ok(())
  }

  /// Decodes one encoded frame (asynchronously: the picture is presented when it comes out).
  pub fn push(&self, data: &[u8]) -> Result<PushOutcome, Error> {
    if data.is_empty() {
      return Err(Error::BadArgument);
    }
    let push_time = platform::now();
    self.shared.lock_stats().pushed += 1;
    let result = self
      .decoder
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .1
      .decode(data, push_time);
    match result {
      Ok(PushOutcome::WaitingForKeyFrame) => self.shared.lock_stats().waiting_for_key += 1,
      Err(Error::Platform(status)) => self.shared.on_decode_error(status),
      _ => {}
    }
    result
  }

  /// Waits until every pushed frame has come out of the decoder.
  pub fn flush(&self) {
    self
      .decoder
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .1
      .flush();
  }

  pub fn stats(&self) -> Stats {
    self.shared.lock_stats().clone()
  }

  /// Queues a window operation for [`Viewer::run_main`].
  pub fn request(&self, op: MainOp) {
    *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(op);
  }

  /// Runs the pending window operation. Must be called on the UI thread.
  pub fn run_main(&self) -> Result<(), Error> {
    if !platform::is_main_thread() {
      return Err(Error::NotMainThread);
    }
    let Some(op) = self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take()
    else {
      return Ok(());
    };
    match op {
      MainOp::Open {
        display,
        fullscreen,
      } => {
        let presenter = Presenter::window(self.shared.clone(), display, fullscreen)?;
        self.start(presenter)
      }
      MainOp::Close => {
        self.stop();
        Ok(())
      }
    }
  }

  /// Presents into an offscreen texture of `width`×`height` (no window: any thread). For
  /// measuring the decode-to-GPU path headless.
  pub fn start_offscreen(&self, width: u32, height: u32) -> Result<(), Error> {
    if width == 0 || height == 0 {
      return Err(Error::BadArgument);
    }
    let presenter = Presenter::offscreen(self.shared.clone(), width, height)?;
    self.start(presenter)
  }

  fn start(&self, presenter: Presenter) -> Result<(), Error> {
    let mut slot = self.presenter.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
      presenter.stop();
      return Err(Error::AlreadyOpen);
    }
    self.shared.set_window_open(presenter.has_window());
    *slot = Some(presenter);
    Ok(())
  }

  /// Stops the presenter (a window one only on the UI thread: it closes the window).
  pub fn stop(&self) {
    let presenter = self
      .presenter
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(presenter) = presenter {
      presenter.stop();
    }
    self.shared.set_window_open(false);
  }

  /// Whether the presenter (if any) has a window, which only the UI thread may close.
  pub fn has_window(&self) -> bool {
    self
      .presenter
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .as_ref()
      .is_some_and(Presenter::has_window)
  }
}

impl Drop for Viewer {
  fn drop(&mut self) {
    let presenter = self
      .presenter
      .get_mut()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(presenter) = presenter {
      if presenter.has_window() && !platform::is_main_thread() {
        // A window is AppKit's: closing it here would be off its thread. Stop drawing and leave
        // the window to the process (the JS API always closes before it destroys).
        presenter.abandon();
      } else {
        presenter.stop();
      }
    }
  }
}
