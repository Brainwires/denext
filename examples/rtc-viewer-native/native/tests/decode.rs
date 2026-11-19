//! Decode round trips on known bytes, headless: the fake camera's own clips (one second of a
//! moving test card, 640×480 at 30 fps, `tests/fixtures/*.bin`, copied from the Deno runtime's
//! `ext/webrtc/fake_media/`: the exact frames a `DENO_FAKE_MEDIA_DEVICES=1` sender puts on the
//! wire) through the hardware decoder, then through the Metal presenter into an offscreen
//! texture. No window is opened.

#![cfg(target_os = "macos")]

use std::collections::HashSet;
use std::time::{Duration, Instant};

use rtcviewer::codec::Codec;
use rtcviewer::ffi;
use rtcviewer::viewer::{Error, FLAG_INSPECT, PushOutcome, Viewer};

/// The clip's `<u32 little-endian length><frame>` records.
fn frames(name: &str) -> Vec<Vec<u8>> {
  let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
  let blob = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
  let mut out = Vec::new();
  let mut rest = blob.as_slice();
  while rest.len() >= 4 {
    let len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
    out.push(rest[4..4 + len].to_vec());
    rest = &rest[4 + len..];
  }
  out
}

/// Decodes every frame of `clip`, one at a time, and checks what came out.
fn round_trip(codec: Codec, clip: &str) {
  let frames = frames(clip);
  assert_eq!(frames.len(), 30, "one second at 30 fps");
  let viewer = Viewer::new(codec, FLAG_INSPECT).expect("a decoder");
  let mut hashes = HashSet::new();
  for frame in &frames {
    assert_eq!(viewer.push(frame), Ok(PushOutcome::Queued));
    viewer.flush();
    hashes.insert(viewer.stats().luma_hash);
  }
  let stats = viewer.stats();
  assert_eq!(stats.pushed, 30);
  assert_eq!(stats.decoded, 30, "{stats:?}");
  assert_eq!(stats.decode_errors, 0, "{stats:?}");
  assert_eq!((stats.width, stats.height), (640, 480));
  // A real picture: the test card is mid-grey on average, not black or garbage-white.
  assert!(
    stats.luma_mean > 40.0 && stats.luma_mean < 220.0,
    "luma {}",
    stats.luma_mean
  );
  // The card moves: (nearly) every decoded picture differs from the others.
  assert!(
    hashes.len() >= 28,
    "{} distinct pictures of 30",
    hashes.len()
  );
  let decode = stats.decode.summary();
  assert!(decode.max > 0.0 && decode.max < 1000.0, "{decode:?}");
}

#[test]
fn h264_round_trip() {
  round_trip(Codec::H264, "h264.bin");
}

#[test]
fn h265_round_trip() {
  round_trip(Codec::H265, "h265.bin");
}

#[test]
fn vp9_round_trip() {
  round_trip(Codec::Vp9, "vp9.bin");
}

#[test]
fn h264_decodes_on_hardware() {
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  viewer.push(&frames("h264.bin")[0]).unwrap();
  viewer.flush();
  // VideoToolbox's answer (1 hardware, 0 software). Apple silicon and every Intel Mac with a
  // T2 / Quick Sync decode H.264 in hardware; a VM may not.
  let hw = viewer.stats().hardware;
  assert!(hw == 0 || hw == 1, "hardware {hw}");
  if std::env::var_os("RTCV_REQUIRE_HARDWARE").is_some() {
    assert_eq!(hw, 1);
  }
}

#[test]
fn a_delta_frame_before_any_key_frame_waits() {
  let frames = frames("h264.bin");
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  assert_eq!(viewer.push(&frames[5]), Ok(PushOutcome::WaitingForKeyFrame));
  assert_eq!(viewer.push(&frames[0]), Ok(PushOutcome::Queued));
  viewer.flush();
  let stats = viewer.stats();
  assert_eq!((stats.waiting_for_key, stats.decoded), (1, 1));
}

#[test]
fn codecs_without_a_decoder_are_refused() {
  assert_eq!(
    Viewer::new(Codec::Av1, 0).err(),
    Some(Error::UnsupportedCodec)
  );
  assert_eq!(
    Viewer::new(Codec::Vp8, 0).err(),
    Some(Error::UnsupportedCodec)
  );
}

#[test]
fn empty_frames_are_refused() {
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  assert_eq!(viewer.push(&[]), Err(Error::BadArgument));
  // Bytes with no start code: nothing to decode, and no session yet.
  assert_eq!(viewer.push(&[1, 2, 3]), Ok(PushOutcome::Queued));
}

#[test]
fn window_work_off_the_main_thread_is_refused() {
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  viewer.request(rtcviewer::viewer::MainOp::Open {
    display: 0,
    fullscreen: true,
  });
  // The test harness runs tests on worker threads: never AppKit's.
  assert_eq!(viewer.run_main(), Err(Error::NotMainThread));
  assert!(!viewer.has_window());
}

/// Waits until `cond` holds, up to five seconds.
fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
  let deadline = Instant::now() + Duration::from_secs(5);
  while Instant::now() < deadline {
    if cond() {
      return true;
    }
    std::thread::sleep(Duration::from_millis(5));
  }
  false
}

#[test]
fn offscreen_presenter_draws_every_picture() {
  let frames = frames("h264.bin");
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  viewer.start_offscreen(1920, 1080).expect("a Metal device");
  for frame in &frames {
    viewer.push(frame).unwrap();
    viewer.flush();
    // One picture in flight at a time, as at 30 fps: none is replaced before it is drawn.
    let decoded = viewer.stats().decoded;
    assert!(
      wait_for(|| viewer.stats().presented == decoded),
      "{:?}",
      viewer.stats()
    );
  }
  let stats = viewer.stats();
  assert_eq!((stats.decoded, stats.presented, stats.dropped), (30, 30, 0));
  let present = stats.present.summary();
  assert!(present.max > 0.0 && present.max < 1000.0, "{present:?}");
  let total = stats.total.summary();
  assert!(total.mean >= present.mean, "{total:?} {present:?}");
  viewer.stop();
  assert!(!viewer.stats().window_open);
}

#[test]
fn offscreen_presenter_keeps_only_the_newest_picture() {
  let frames = frames("h264.bin");
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  viewer.start_offscreen(640, 480).unwrap();
  // As fast as possible: pictures may replace each other in the mailbox; none is lost track of.
  for frame in &frames {
    viewer.push(frame).unwrap();
  }
  viewer.flush();
  assert!(wait_for(|| {
    let s = viewer.stats();
    s.presented + s.dropped == s.decoded
  }));
  assert_eq!(viewer.start_offscreen(640, 480), Err(Error::AlreadyOpen));
  viewer.stop();
}

#[test]
fn the_c_abi_round_trip() {
  let frames = frames("h265.bin");
  let id = ffi::rtcv_create(Codec::H265 as u32, FLAG_INSPECT);
  assert!(id > 0, "error {id}");
  let id = id as u32;
  for frame in &frames {
    // SAFETY: the frame outlives the call.
    assert_eq!(
      unsafe { ffi::rtcv_push(id, frame.as_ptr(), frame.len()) },
      0
    );
  }
  assert_eq!(ffi::rtcv_flush(id), 0);
  let mut out = vec![0f64; ffi::rtcv_stat_count() as usize + 4];
  // SAFETY: `out` holds `out.len()` values.
  let n = unsafe { ffi::rtcv_stats(id, out.as_mut_ptr(), out.len()) };
  assert_eq!(n as u32, ffi::rtcv_stat_count());
  assert_eq!(out[0], 30.0); // pushed
  assert_eq!(out[1], 30.0); // decoded
  assert_eq!((out[7], out[8]), (640.0, 480.0)); // width, height
  // The window entry refuses off the UI thread, as the JS side relies on.
  assert_eq!(ffi::rtcv_request_open(id, 0, 1), 0);
  let context = id as usize as *mut std::ffi::c_void;
  assert_eq!(
    ffi::rtcv_main(context) as isize,
    Error::NotMainThread.code() as isize
  );
  assert_eq!(ffi::rtcv_start_offscreen(id, 320, 240), 0);
  assert_eq!(ffi::rtcv_stop_offscreen(id), 0);
  assert_eq!(ffi::rtcv_destroy(id), 0);
  // A stale id is refused, not used.
  // SAFETY: the frame outlives the call.
  let stale = unsafe { ffi::rtcv_push(id, frames[0].as_ptr(), frames[0].len()) };
  assert_eq!(stale, Error::BadArgument.code());
}

#[test]
fn switching_codecs_keeps_decoding() {
  let viewer = Viewer::new(Codec::H264, 0).unwrap();
  for frame in &frames("h264.bin")[..5] {
    viewer.push(frame).unwrap();
  }
  viewer.set_codec(Codec::H265).unwrap();
  for frame in &frames("h265.bin")[..5] {
    assert_eq!(viewer.push(frame), Ok(PushOutcome::Queued));
  }
  viewer.flush();
  let stats = viewer.stats();
  assert_eq!((stats.decoded, stats.decode_errors), (10, 0));
  assert_eq!(viewer.set_codec(Codec::Av1), Err(Error::UnsupportedCodec));
}
