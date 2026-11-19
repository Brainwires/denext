//! The codecs the viewer is asked for, by the numbers the C ABI uses.

/// A video codec. The numbers are the C ABI's (`rtcv_create`'s `codec`) and `lib/native.ts`'s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Codec {
  H264 = 1,
  H265 = 2,
  Vp9 = 3,
  Av1 = 4,
  Vp8 = 5,
}

impl Codec {
  /// The codec for an ABI number.
  pub fn from_abi(value: u32) -> Option<Self> {
    Some(match value {
      1 => Self::H264,
      2 => Self::H265,
      3 => Self::Vp9,
      4 => Self::Av1,
      5 => Self::Vp8,
      _ => return None,
    })
  }

  /// Whether frames arrive as Annex B access units.
  pub fn is_annex_b(self) -> bool {
    matches!(self, Self::H264 | Self::H265)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn abi_numbers_round_trip() {
    for codec in [Codec::H264, Codec::H265, Codec::Vp9, Codec::Av1, Codec::Vp8] {
      assert_eq!(Codec::from_abi(codec as u32), Some(codec));
    }
    assert_eq!(Codec::from_abi(0), None);
    assert_eq!(Codec::from_abi(6), None);
    assert!(Codec::H265.is_annex_b());
    assert!(!Codec::Vp9.is_annex_b());
  }
}
