//! Y'CbCr → R'G'B' for the presenter's shader: one 4×4 matrix (column-major, as Metal's
//! `float4x4` and HLSL / GLSL take it) that removes the range offsets and applies the matrix
//! coefficients in a single multiply.

/// The matrix coefficients of a picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Matrix {
  Bt601,
  Bt709,
  Bt2020,
}

/// The column-major 4×4 matrix taking `(Y, Cb, Cr, 1)` sampled as unorm (0-1) to linear-free
/// `(R, G, B, 1)`, for video range (`full_range == false`: Y in 16-235, C in 16-240) or full range.
pub fn yuv_to_rgb(matrix: Matrix, full_range: bool) -> [f32; 16] {
  let (kr, kb) = match matrix {
    Matrix::Bt601 => (0.299, 0.114),
    Matrix::Bt709 => (0.2126, 0.0722),
    Matrix::Bt2020 => (0.2627, 0.0593),
  };
  let kg = 1.0 - kr - kb;
  // R = Y + cr_r·Cr; G = Y − cb_g·Cb − cr_g·Cr; B = Y + cb_b·Cb (Cb, Cr centred on 0).
  let cr_r = 2.0 * (1.0 - kr);
  let cb_b = 2.0 * (1.0 - kb);
  let cb_g = cb_b * kb / kg;
  let cr_g = cr_r * kr / kg;
  let (y_scale, y_off, c_scale) = if full_range {
    (1.0, 0.0, 1.0)
  } else {
    (255.0 / 219.0, 16.0 / 255.0, 255.0 / 224.0)
  };
  let c_off = 128.0 / 255.0;
  // rgb = M · (y·ys − y_off·ys, (cb − c_off)·cs, (cr − c_off)·cs).
  let ys = y_scale;
  let cs = c_scale;
  let col_y = [ys, ys, ys, 0.0];
  let col_cb = [0.0, -cb_g * cs, cb_b * cs, 0.0];
  let col_cr = [cr_r * cs, -cr_g * cs, 0.0, 0.0];
  // The constant column: every offset pushed through its coefficient.
  let t = [
    -y_off * ys - c_off * cs * cr_r,
    -y_off * ys + c_off * cs * (cb_g + cr_g),
    -y_off * ys - c_off * cs * cb_b,
    1.0,
  ];
  let mut m = [0f32; 16];
  for (i, v) in col_y
    .iter()
    .chain(&col_cb)
    .chain(&col_cr)
    .chain(&t)
    .enumerate()
  {
    m[i] = *v as f32;
  }
  m
}

#[cfg(test)]
mod tests {
  use super::*;

  fn apply(m: &[f32; 16], y: f32, cb: f32, cr: f32) -> [f32; 3] {
    let v = [y, cb, cr, 1.0];
    let mut out = [0f32; 3];
    for (row, o) in out.iter_mut().enumerate() {
      *o = (0..4).map(|col| m[col * 4 + row] * v[col]).sum();
    }
    out
  }

  fn close(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.01)
  }

  #[test]
  fn video_range_black_white_and_grey() {
    for matrix in [Matrix::Bt601, Matrix::Bt709, Matrix::Bt2020] {
      let m = yuv_to_rgb(matrix, false);
      let c = 128.0 / 255.0;
      assert!(
        close(apply(&m, 16.0 / 255.0, c, c), [0.0, 0.0, 0.0]),
        "{matrix:?} black"
      );
      assert!(
        close(apply(&m, 235.0 / 255.0, c, c), [1.0, 1.0, 1.0]),
        "{matrix:?} white"
      );
    }
  }

  #[test]
  fn full_range_primaries_bt709() {
    let m = yuv_to_rgb(Matrix::Bt709, true);
    // Pure red in BT.709 full range: Y = 0.2126, Cb = 0.5 - 0.1146, Cr = 0.5 + 0.5.
    let red = apply(&m, 0.2126, 0.5 - 0.114_572, 1.0);
    assert!(close(red, [1.0, 0.0, 0.0]), "{red:?}");
    let blue = apply(&m, 0.0722, 1.0, 0.5 - 0.045_847);
    assert!(close(blue, [0.0, 0.0, 1.0]), "{blue:?}");
  }
}
