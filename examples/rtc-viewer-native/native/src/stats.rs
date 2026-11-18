//! The counters and latency distributions `rtcv_stats` reports. Latencies are seconds on the
//! platform clock (`platform::now`) in, milliseconds out.

use std::collections::VecDeque;

/// How many recent samples a latency distribution keeps.
const WINDOW: usize = 512;

/// A latency distribution over the last [`WINDOW`] samples.
#[derive(Debug, Default, Clone)]
pub struct Latency {
  samples: VecDeque<f64>,
  last: f64,
}

/// A distribution's summary, in milliseconds.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Summary {
  pub last: f64,
  pub mean: f64,
  pub p50: f64,
  pub p95: f64,
  pub max: f64,
}

impl Latency {
  /// Records one latency, in seconds.
  pub fn record(&mut self, seconds: f64) {
    let ms = seconds * 1000.0;
    if !ms.is_finite() || ms < 0.0 {
      return;
    }
    if self.samples.len() == WINDOW {
      self.samples.pop_front();
    }
    self.samples.push_back(ms);
    self.last = ms;
  }

  /// The summary of the samples kept (all zero with none).
  pub fn summary(&self) -> Summary {
    if self.samples.is_empty() {
      return Summary::default();
    }
    let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
    sorted.sort_by(f64::total_cmp);
    let at = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
    Summary {
      last: self.last,
      mean: sorted.iter().sum::<f64>() / sorted.len() as f64,
      p50: at(0.5),
      p95: at(0.95),
      max: sorted[sorted.len() - 1],
    }
  }
}

/// Everything `rtcv_stats` reports.
#[derive(Debug, Default, Clone)]
pub struct Stats {
  /// Frames handed to `rtcv_push`.
  pub pushed: u64,
  /// Frames the decoder put out.
  pub decoded: u64,
  /// Frames that reached the screen (or the offscreen target).
  pub presented: u64,
  /// Of `presented`, the frames whose drawable reported no display time (a VM's virtual display
  /// reports none): their present latency is measured to GPU completion instead.
  pub presented_untimed: u64,
  /// Frames decoded but never shown: replaced by a newer one before the presenter took it, or
  /// dropped by the compositor.
  pub dropped: u64,
  /// Frames the decoder refused or failed.
  pub decode_errors: u64,
  /// Frames dropped before the first key frame (nothing to decode them against).
  pub waiting_for_key: u64,
  pub width: u32,
  pub height: u32,
  /// 1 hardware decode, 0 software, -1 not known yet.
  pub hardware: i8,
  /// The last platform error code (an `OSStatus` on macOS), 0 for none.
  pub last_status: i32,
  pub window_open: bool,
  /// `rtcv_push` → decoded picture.
  pub decode: Latency,
  /// Decoded picture → on screen (the drawable's presented time) or offscreen render complete.
  pub present: Latency,
  /// `rtcv_push` → on screen: what the viewer adds to the glass-to-glass time.
  pub total: Latency,
  /// Inspection (`RTCV_FLAG_INSPECT`): the last decoded picture's mean luma (0-255) and a hash of
  /// sampled luma bytes.
  pub luma_mean: f64,
  pub luma_hash: u32,
}

/// The names of the fields `Stats::to_array` writes, in order. `lib/native.ts`'s `STAT_FIELDS`
/// must list the same (tests/decode.rs and the Deno tests check the count).
pub const FIELDS: &[&str] = &[
  "pushed",
  "decoded",
  "presented",
  "presentedUntimed",
  "dropped",
  "decodeErrors",
  "waitingForKey",
  "width",
  "height",
  "hardware",
  "lastStatus",
  "windowOpen",
  "decodeLast",
  "decodeMean",
  "decodeP50",
  "decodeP95",
  "decodeMax",
  "presentLast",
  "presentMean",
  "presentP50",
  "presentP95",
  "presentMax",
  "totalLast",
  "totalMean",
  "totalP50",
  "totalP95",
  "totalMax",
  "lumaMean",
  "lumaHash",
];

impl Stats {
  /// The fields of [`FIELDS`], as numbers.
  pub fn to_array(&self) -> Vec<f64> {
    let mut out = vec![
      self.pushed as f64,
      self.decoded as f64,
      self.presented as f64,
      self.presented_untimed as f64,
      self.dropped as f64,
      self.decode_errors as f64,
      self.waiting_for_key as f64,
      f64::from(self.width),
      f64::from(self.height),
      f64::from(self.hardware),
      f64::from(self.last_status),
      if self.window_open { 1.0 } else { 0.0 },
    ];
    for s in [
      self.decode.summary(),
      self.present.summary(),
      self.total.summary(),
    ] {
      out.extend([s.last, s.mean, s.p50, s.p95, s.max]);
    }
    out.push(self.luma_mean);
    out.push(f64::from(self.luma_hash));
    debug_assert_eq!(out.len(), FIELDS.len());
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn summary_of_samples() {
    let mut l = Latency::default();
    assert_eq!(l.summary(), Summary::default());
    for ms in 1..=100 {
      l.record(f64::from(ms) / 1000.0);
    }
    let s = l.summary();
    assert!((s.last - 100.0).abs() < 1e-9);
    assert!((s.mean - 50.5).abs() < 1e-9);
    assert!((s.p50 - 51.0).abs() < 1e-9 || (s.p50 - 50.0).abs() < 1e-9);
    assert!((s.p95 - 95.0).abs() < 1.01);
    assert!((s.max - 100.0).abs() < 1e-9);
  }

  #[test]
  fn keeps_a_window_and_ignores_nonsense() {
    let mut l = Latency::default();
    for _ in 0..WINDOW {
      l.record(1.0);
    }
    l.record(0.002);
    l.record(-1.0);
    l.record(f64::NAN);
    assert_eq!(l.samples.len(), WINDOW);
    assert!((l.summary().last - 2.0).abs() < 1e-9);
  }

  #[test]
  fn array_matches_the_field_names() {
    assert_eq!(Stats::default().to_array().len(), FIELDS.len());
  }
}
