//! H.264 / H.265 access units as WebRTC's depacketizers hand them over: Annex B (each NAL unit
//! behind a `00 00 01` or `00 00 00 01` start code), the parameter sets repeated in front of every
//! key frame. A decoder wants the parameter sets apart (they make its format description) and
//! the rest as one length-prefixed sample (`AVCC` / `HVCC`, 4-byte big-endian lengths).

use crate::codec::Codec;

/// The NAL units of an Annex B buffer, start codes removed. Bytes before the first start code
/// (there should be none) are ignored; a trailing zero byte that belongs to the next 4-byte start
/// code is not part of the unit before it.
pub fn split_nals(data: &[u8]) -> Vec<&[u8]> {
  let mut starts = Vec::new();
  let mut i = 0;
  while i + 3 <= data.len() {
    if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
      starts.push(i + 3);
      i += 3;
    } else {
      i += 1;
    }
  }
  let mut out = Vec::with_capacity(starts.len());
  for (n, &start) in starts.iter().enumerate() {
    let mut end = match starts.get(n + 1) {
      Some(&next) => next - 3,
      None => data.len(),
    };
    // Trailing zeros: the leading zero of a 4-byte start code, or `trailing_zero_8bits`.
    while end > start && data[end - 1] == 0 {
      end -= 1;
    }
    if end > start {
      out.push(&data[start..end]);
    }
  }
  out
}

/// What a NAL unit is, for the decoder's purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NalKind {
  /// H.265 video parameter set.
  Vps,
  /// Sequence parameter set.
  Sps,
  /// Picture parameter set.
  Pps,
  /// Access unit delimiter: dropped (the sample boundary says the same).
  Aud,
  /// An IDR / IRAP picture slice: the frame is a key frame.
  KeySlice,
  /// Anything else (other slices, SEI, …): passed to the decoder as it is.
  Other,
}

/// The kind of `nal` in `codec` (H.264 or H.265 only).
pub fn nal_kind(codec: Codec, nal: &[u8]) -> NalKind {
  let Some(&first) = nal.first() else {
    return NalKind::Other;
  };
  match codec {
    Codec::H264 => match first & 0x1f {
      7 => NalKind::Sps,
      8 => NalKind::Pps,
      9 => NalKind::Aud,
      5 => NalKind::KeySlice,
      _ => NalKind::Other,
    },
    Codec::H265 => match (first >> 1) & 0x3f {
      32 => NalKind::Vps,
      33 => NalKind::Sps,
      34 => NalKind::Pps,
      35 => NalKind::Aud,
      // BLA_W_LP .. CRA_NUT: the IRAP pictures a decoder can start at.
      16..=21 => NalKind::KeySlice,
      _ => NalKind::Other,
    },
    _ => NalKind::Other,
  }
}

/// The most recent parameter sets seen, which a format description is made from.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ParamSets {
  pub vps: Option<Vec<u8>>,
  pub sps: Option<Vec<u8>>,
  pub pps: Option<Vec<u8>>,
}

impl ParamSets {
  /// Whether there is enough to describe the stream: SPS and PPS (and VPS for H.265).
  pub fn complete(&self, codec: Codec) -> bool {
    self.sps.is_some() && self.pps.is_some() && (codec != Codec::H265 || self.vps.is_some())
  }

  /// The sets in the order a format description takes them (VPS, SPS, PPS).
  pub fn ordered(&self) -> Vec<&[u8]> {
    [&self.vps, &self.sps, &self.pps]
      .into_iter()
      .flatten()
      .map(Vec::as_slice)
      .collect()
  }
}

/// One access unit, ready for a decoder.
#[derive(Debug, Default)]
pub struct AccessUnit {
  /// The NAL units other than parameter sets and delimiters, each behind its 4-byte big-endian
  /// length.
  pub sample: Vec<u8>,
  /// Whether the unit holds a key (IDR / IRAP) slice.
  pub key: bool,
  /// Whether this unit changed the parameter sets (a new format description is due).
  pub params_changed: bool,
}

/// Turns an Annex B access unit into a length-prefixed sample, updating `params` with the
/// parameter sets it carries.
pub fn to_sample(codec: Codec, data: &[u8], params: &mut ParamSets) -> AccessUnit {
  let mut unit = AccessUnit {
    sample: Vec::with_capacity(data.len() + 16),
    ..Default::default()
  };
  for nal in split_nals(data) {
    let slot = match nal_kind(codec, nal) {
      NalKind::Vps => Some(&mut params.vps),
      NalKind::Sps => Some(&mut params.sps),
      NalKind::Pps => Some(&mut params.pps),
      NalKind::Aud => continue,
      NalKind::KeySlice => {
        unit.key = true;
        None
      }
      NalKind::Other => None,
    };
    if let Some(slot) = slot {
      if slot.as_deref() != Some(nal) {
        *slot = Some(nal.to_vec());
        unit.params_changed = true;
      }
      continue;
    }
    unit
      .sample
      .extend_from_slice(&(nal.len() as u32).to_be_bytes());
    unit.sample.extend_from_slice(nal);
  }
  unit
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn splits_three_and_four_byte_start_codes() {
    let data = [
      0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 0,
    ];
    let nals = split_nals(&data);
    assert_eq!(
      nals,
      vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]
    );
  }

  #[test]
  fn no_start_code_means_no_units() {
    assert!(split_nals(&[1, 2, 3, 4]).is_empty());
    assert!(split_nals(&[]).is_empty());
  }

  #[test]
  fn h264_sample_drops_param_sets_and_aud() {
    let data = [
      0, 0, 0, 1, 0x09, 0xf0, // AUD
      0, 0, 0, 1, 0x67, 0x42, 0x00, // SPS
      0, 0, 0, 1, 0x68, 0xce, // PPS
      0, 0, 0, 1, 0x65, 0x88, 0x84, // IDR slice
    ];
    let mut params = ParamSets::default();
    let unit = to_sample(Codec::H264, &data, &mut params);
    assert!(unit.key);
    assert!(unit.params_changed);
    assert!(params.complete(Codec::H264));
    assert_eq!(unit.sample, vec![0, 0, 0, 3, 0x65, 0x88, 0x84]);
    // The same sets again: no change.
    let again = to_sample(Codec::H264, &data, &mut params);
    assert!(!again.params_changed);
  }

  #[test]
  fn h265_kinds() {
    // nal_unit_type is bits 1..7 of the first header byte.
    assert_eq!(nal_kind(Codec::H265, &[32 << 1, 1]), NalKind::Vps);
    assert_eq!(nal_kind(Codec::H265, &[33 << 1, 1]), NalKind::Sps);
    assert_eq!(nal_kind(Codec::H265, &[34 << 1, 1]), NalKind::Pps);
    assert_eq!(nal_kind(Codec::H265, &[35 << 1, 1]), NalKind::Aud);
    assert_eq!(nal_kind(Codec::H265, &[19 << 1, 1]), NalKind::KeySlice);
    assert_eq!(nal_kind(Codec::H265, &[1 << 1, 1]), NalKind::Other);
    let mut params = ParamSets {
      sps: Some(vec![1]),
      pps: Some(vec![2]),
      vps: None,
    };
    assert!(!params.complete(Codec::H265));
    params.vps = Some(vec![0]);
    assert!(params.complete(Codec::H265));
    assert_eq!(params.ordered(), vec![&[0][..], &[1][..], &[2][..]]);
  }
}
