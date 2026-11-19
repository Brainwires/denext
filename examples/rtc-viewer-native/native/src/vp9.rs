//! The bit of VP9's uncompressed frame header a decoder needs up front: a key frame's size, profile,
//! bit depth and colour description, and from them the `vpcC` record (VP Codec ISO-BMFF binding,
//! version 1) a format description carries.

/// What a VP9 key frame header says about the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyFrameInfo {
  pub width: u32,
  pub height: u32,
  pub profile: u8,
  pub bit_depth: u8,
  /// VP9's `color_space` (0 unknown, 1 BT.601, 2 BT.709, …, 7 sRGB).
  pub color_space: u8,
  pub full_range: bool,
  pub subsampling_x: bool,
  pub subsampling_y: bool,
}

struct Bits<'a> {
  data: &'a [u8],
  pos: usize,
}

impl Bits<'_> {
  fn read(&mut self, n: u32) -> Option<u32> {
    let mut value = 0u32;
    for _ in 0..n {
      let byte = *self.data.get(self.pos / 8)?;
      let bit = (byte >> (7 - (self.pos % 8))) & 1;
      value = (value << 1) | u32::from(bit);
      self.pos += 1;
    }
    Some(value)
  }
}

/// The header of `frame` when it is a key frame, `None` for an inter frame or a header that
/// doesn't parse.
pub fn parse_key_frame(frame: &[u8]) -> Option<KeyFrameInfo> {
  let mut b = Bits {
    data: frame,
    pos: 0,
  };
  if b.read(2)? != 2 {
    return None; // frame_marker
  }
  let low = b.read(1)?;
  let high = b.read(1)?;
  let profile = ((high << 1) | low) as u8;
  if profile == 3 {
    b.read(1)?; // reserved_zero
  }
  if b.read(1)? == 1 {
    return None; // show_existing_frame
  }
  if b.read(1)? != 0 {
    return None; // frame_type: not KEY_FRAME
  }
  b.read(2)?; // show_frame, error_resilient_mode
  if b.read(24)? != 0x49_83_42 {
    return None; // frame_sync_code
  }
  let bit_depth = if profile >= 2 {
    if b.read(1)? == 1 { 12 } else { 10 }
  } else {
    8
  };
  let color_space = b.read(3)? as u8;
  let (full_range, subsampling_x, subsampling_y);
  if color_space != 7 {
    full_range = b.read(1)? == 1;
    if profile == 1 || profile == 3 {
      subsampling_x = b.read(1)? == 1;
      subsampling_y = b.read(1)? == 1;
      b.read(1)?;
    } else {
      subsampling_x = true;
      subsampling_y = true;
    }
  } else {
    full_range = true;
    subsampling_x = false;
    subsampling_y = false;
    if profile == 1 || profile == 3 {
      b.read(1)?;
    }
  }
  let width = b.read(16)? + 1;
  let height = b.read(16)? + 1;
  Some(KeyFrameInfo {
    width,
    height,
    profile,
    bit_depth,
    color_space,
    full_range,
    subsampling_x,
    subsampling_y,
  })
}

impl KeyFrameInfo {
  /// The `vpcC` box payload (a FullBox: version 1, no flags) for this stream.
  pub fn vpcc(&self) -> [u8; 12] {
    let chroma = match (self.subsampling_x, self.subsampling_y) {
      (true, true) => 1, // 4:2:0, chroma co-located with luma
      (true, false) => 2,
      _ => 3,
    };
    // colour_primaries, transfer_characteristics, matrix_coefficients (ISO/IEC 23091-2).
    let (primaries, transfer, matrix) = match self.color_space {
      1 => (6, 6, 6),  // BT.601
      2 => (1, 1, 1),  // BT.709
      5 => (9, 14, 9), // BT.2020
      7 => (1, 13, 0), // sRGB
      _ => (2, 2, 2),  // unspecified
    };
    [
      1,
      0,
      0,
      0, // version, flags
      self.profile,
      0, // level: unspecified
      (self.bit_depth << 4) | (chroma << 1) | u8::from(self.full_range),
      primaries,
      transfer,
      matrix,
      0,
      0, // codecIntializationDataSize
    ]
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A profile 0 key frame header: marker 10, profile 00, show_existing 0, frame_type 0,
  // show_frame 1, error_res 0, sync code, color_space 2 (BT.709), color_range 0,
  // width-1 = 639, height-1 = 479.
  fn header() -> Vec<u8> {
    let mut bits = String::from("10") + "00" + "0" + "0" + "1" + "0";
    bits += "010010011000001101000010"; // 0x49 0x83 0x42
    bits += "010"; // color_space
    bits += "0"; // color_range
    bits += &format!("{:016b}", 639);
    bits += &format!("{:016b}", 479);
    while !bits.len().is_multiple_of(8) {
      bits.push('0');
    }
    bits
      .as_bytes()
      .chunks(8)
      .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 2).unwrap())
      .collect()
  }

  #[test]
  fn parses_a_key_frame_header() {
    let info = parse_key_frame(&header()).unwrap();
    assert_eq!((info.width, info.height), (640, 480));
    assert_eq!(info.profile, 0);
    assert_eq!(info.bit_depth, 8);
    assert_eq!(info.color_space, 2);
    assert!(!info.full_range);
    assert_eq!(info.vpcc(), [1, 0, 0, 0, 0, 0, 0x82, 1, 1, 1, 0, 0]);
  }

  #[test]
  fn an_inter_frame_is_not_a_key_frame() {
    let mut h = header();
    h[0] |= 0b0000_0100; // frame_type = 1
    assert_eq!(parse_key_frame(&h), None);
    assert_eq!(parse_key_frame(&[]), None);
    assert_eq!(parse_key_frame(&[0xff]), None);
  }
}
