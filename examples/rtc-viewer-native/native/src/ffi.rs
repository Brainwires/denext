//! The C ABI `lib/native.ts` opens with `Deno.dlopen`.
//!
//! A viewer is named by an id (a positive `u32`), not a pointer: the library keeps the viewers in
//! a registry, and each call holds its viewer for the call's length. So a call with a stale id —
//! a transform worker still pushing a frame after the app destroyed its viewer — is refused
//! (`-1`), never a use-after-free; and a destroy that races a push frees the viewer when the push
//! returns. Every function returns 0 or a positive outcome on success, a negative
//! [`Error::code`] on failure, and nothing panics across the boundary (a panic is `-1`).
//!
//! Threads: everything but `rtcv_main` may run on any thread (the JavaScript thread, or the
//! RTCRtpScriptTransform's worker). Window work runs only in `rtcv_main`, which the app calls on
//! the UI thread with `Deno.desktop.runOnMainThread(rtcv_main_fn(), id)`.

use std::collections::HashMap;
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::codec::Codec;
use crate::stats::FIELDS;
use crate::viewer::{Error, MainOp, Viewer};

/// Bumped when a signature or the stats layout changes; `lib/native.ts` checks it.
pub const ABI_VERSION: u32 = 1;

fn registry() -> MutexGuard<'static, HashMap<u32, Arc<Viewer>>> {
  static VIEWERS: OnceLock<Mutex<HashMap<u32, Arc<Viewer>>>> = OnceLock::new();
  VIEWERS
    .get_or_init(Default::default)
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

/// Runs `f` with viewer `id` (the registry lock is not held during `f`).
fn with(id: u32, f: impl FnOnce(&Viewer) -> Result<i32, Error>) -> i32 {
  let Some(viewer) = registry().get(&id).cloned() else {
    return Error::BadArgument.code();
  };
  catch_unwind(AssertUnwindSafe(|| f(&viewer)))
    .unwrap_or(Err(Error::BadArgument))
    .unwrap_or_else(Error::code)
}

#[unsafe(no_mangle)]
pub extern "C" fn rtcv_abi_version() -> u32 {
  ABI_VERSION
}

/// How many numbers `rtcv_stats` writes.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_stat_count() -> u32 {
  FIELDS.len() as u32
}

/// A viewer for `codec` (1 H.264, 2 H.265, 3 VP9, 4 AV1, 5 VP8) with `flags` (1: inspect).
/// Returns its id (> 0) or a negative error code.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_create(codec: u32, flags: u32) -> i32 {
  static NEXT: AtomicU32 = AtomicU32::new(1);
  let made = catch_unwind(|| {
    let codec = Codec::from_abi(codec).ok_or(Error::BadArgument)?;
    Viewer::new(codec, flags)
  })
  .unwrap_or(Err(Error::BadArgument));
  match made {
    Ok(viewer) => {
      let id = NEXT.fetch_add(1, Ordering::Relaxed) & 0x7fff_ffff;
      registry().insert(id, Arc::new(viewer));
      id as i32
    }
    Err(e) => e.code(),
  }
}

/// Switches viewer `id` to `codec`, keeping its window.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_set_codec(id: u32, codec: u32) -> i32 {
  with(id, |v| {
    v.set_codec(Codec::from_abi(codec).ok_or(Error::BadArgument)?)?;
    Ok(0)
  })
}

/// Decodes one encoded frame (`len` bytes at `data`, copied before return). 0 queued, 1 dropped
/// waiting for a key frame.
///
/// # Safety
/// `data` points to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtcv_push(id: u32, data: *const u8, len: usize) -> i32 {
  if data.is_null() || len == 0 {
    return Error::BadArgument.code();
  }
  // SAFETY: the caller's.
  let bytes = unsafe { std::slice::from_raw_parts(data, len) };
  with(id, |v| Ok(v.push(bytes)? as i32))
}

/// Waits until every pushed frame has come out of the decoder.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_flush(id: u32) -> i32 {
  with(id, |v| {
    v.flush();
    Ok(0)
  })
}

/// Writes up to `cap` numbers of the stats (`rtcv_stat_count` in all) to `out`; returns how many.
///
/// # Safety
/// `out` points to `cap` writable `f64`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtcv_stats(id: u32, out: *mut f64, cap: usize) -> i32 {
  if out.is_null() {
    return Error::BadArgument.code();
  }
  with(id, |v| {
    let values = v.stats().to_array();
    let n = values.len().min(cap);
    // SAFETY: the caller's: `out` holds `cap` >= `n` values.
    unsafe { std::ptr::copy_nonoverlapping(values.as_ptr(), out, n) };
    Ok(n as i32)
  })
}

/// Queues opening the window (on display `display`, 0 the main one; full-screen when
/// `fullscreen` is not 0) for the next `rtcv_main`.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_request_open(id: u32, display: i32, fullscreen: u32) -> i32 {
  with(id, |v| {
    v.request(MainOp::Open {
      display,
      fullscreen: fullscreen != 0,
    });
    Ok(0)
  })
}

/// Queues closing the window for the next `rtcv_main`.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_request_close(id: u32) -> i32 {
  with(id, |v| {
    v.request(MainOp::Close);
    Ok(0)
  })
}

/// Runs viewer `context`'s queued window operation (the id, passed as a pointer-sized integer):
/// `void* fn(void* context)` for `Deno.desktop.runOnMainThread`. Returns 0 or a negative code,
/// as a pointer-sized integer.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_main(context: *mut c_void) -> *mut c_void {
  let id = u32::try_from(context as usize).unwrap_or(0);
  with(id, |v| v.run_main().map(|()| 0)) as isize as *mut c_void
}

/// The address of [`rtcv_main`], for `runOnMainThread`.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_main_fn() -> *const c_void {
  rtcv_main as *const c_void
}

/// Presents into an offscreen `width`×`height` target instead of a window (any thread).
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_start_offscreen(id: u32, width: u32, height: u32) -> i32 {
  with(id, |v| v.start_offscreen(width, height).map(|()| 0))
}

/// Stops an offscreen presenter. A window is closed only through `rtcv_main`.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_stop_offscreen(id: u32) -> i32 {
  with(id, |v| {
    if v.has_window() {
      return Err(Error::NotMainThread);
    }
    v.stop();
    Ok(0)
  })
}

/// Forgets viewer `id`; it is freed once no call holds it. Close its window first
/// (`rtcv_request_close` + `rtcv_main`). 0, or -1 for an unknown id.
#[unsafe(no_mangle)]
pub extern "C" fn rtcv_destroy(id: u32) -> i32 {
  let removed = registry().remove(&id);
  match removed {
    Some(viewer) => {
      // Dropped here, outside the registry lock (it may wait for the decoder).
      let _ = catch_unwind(AssertUnwindSafe(|| drop(viewer)));
      0
    }
    None => Error::BadArgument.code(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn unknown_ids_are_refused() {
    let bad = Error::BadArgument.code();
    // SAFETY: null pointers are what is being tested.
    unsafe {
      assert_eq!(rtcv_push(0, std::ptr::null(), 0), bad);
      assert_eq!(rtcv_push(12345, [1u8].as_ptr(), 1), bad);
      assert_eq!(rtcv_stats(0, std::ptr::null_mut(), 0), bad);
    }
    assert_eq!(rtcv_flush(0), bad);
    assert_eq!(rtcv_request_open(0, 0, 1), bad);
    assert_eq!(rtcv_request_close(0), bad);
    assert_eq!(rtcv_main(std::ptr::null_mut()) as isize, bad as isize);
    assert_eq!(rtcv_start_offscreen(0, 1, 1), bad);
    assert_eq!(rtcv_stop_offscreen(0), bad);
    assert_eq!(rtcv_set_codec(0, 1), bad);
    assert_eq!(rtcv_destroy(0), bad);
  }

  #[test]
  fn a_bad_codec_is_refused() {
    assert_eq!(rtcv_create(99, 0), Error::BadArgument.code());
    assert_eq!(rtcv_stat_count() as usize, FIELDS.len());
    assert_eq!(rtcv_abi_version(), ABI_VERSION);
    assert!(!rtcv_main_fn().is_null());
  }
}
