//! Measures the viewer's own latency, headless: the fake camera's clip looped at its real rate
//! (30 fps) through the hardware decoder and the Metal presenter into an offscreen 1920×1080
//! target. Prints the distributions `stats()` reports.
//!
//! `cargo run --release --example measure [-- <codec> <seconds>]` (codec: h264, h265, vp9).
//!
//! What it measures: push → decoded (VideoToolbox), decoded → GPU done (the shader pass), and
//! push → GPU done. On screen the drawable's `presentedTime` replaces "GPU done", which adds the
//! compositor's wait for the next refresh (up to one frame at 60 Hz, 16.7 ms; less on a 120 Hz
//! display; none when the window is scanned out directly).

use std::time::{Duration, Instant};

use rtcviewer::codec::Codec;
use rtcviewer::viewer::Viewer;

fn main() {
  let mut args = std::env::args().skip(1);
  let codec = args.next().unwrap_or_else(|| "h264".into());
  let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(10);
  let (id, clip) = match codec.as_str() {
    "h264" => (Codec::H264, "h264.bin"),
    "h265" => (Codec::H265, "h265.bin"),
    "vp9" => (Codec::Vp9, "vp9.bin"),
    other => panic!("unknown codec {other}"),
  };
  let blob = std::fs::read(format!(
    "{}/tests/fixtures/{clip}",
    env!("CARGO_MANIFEST_DIR")
  ))
  .unwrap();
  let mut frames = Vec::new();
  let mut rest = blob.as_slice();
  while rest.len() >= 4 {
    let len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
    frames.push(rest[4..4 + len].to_vec());
    rest = &rest[4 + len..];
  }

  let viewer = Viewer::new(id, 0).expect("decoder");
  viewer.start_offscreen(1920, 1080).expect("Metal");
  let period = Duration::from_secs_f64(1.0 / 30.0);
  let start = Instant::now();
  let total = (seconds * 30) as usize;
  for i in 0..total {
    viewer.push(&frames[i % frames.len()]).unwrap();
    let next = start + period * (i as u32 + 1);
    if let Some(wait) = next.checked_duration_since(Instant::now()) {
      std::thread::sleep(wait);
    }
  }
  viewer.flush();
  std::thread::sleep(Duration::from_millis(100));
  let s = viewer.stats();
  viewer.stop();
  println!(
    "codec {codec}, {}x{}, hardware {}, {} frames at 30 fps",
    s.width, s.height, s.hardware, total
  );
  println!(
    "pushed {} decoded {} presented {} dropped {} errors {}",
    s.pushed, s.decoded, s.presented, s.dropped, s.decode_errors
  );
  println!(
    "{:<26} {:>8} {:>8} {:>8} {:>8}",
    "ms (last 512 frames)", "mean", "p50", "p95", "max"
  );
  for (name, l) in [
    ("push -> decoded", &s.decode),
    ("decoded -> GPU done", &s.present),
    ("push -> GPU done", &s.total),
  ] {
    let m = l.summary();
    println!(
      "{name:<26} {:>8.2} {:>8.2} {:>8.2} {:>8.2}",
      m.mean, m.p50, m.p95, m.max
    );
  }
}
