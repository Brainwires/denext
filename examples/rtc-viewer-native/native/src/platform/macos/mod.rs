//! macOS: VideoToolbox decode (`decoder.rs`) → IOSurface-backed `CVPixelBuffer` → Metal
//! (`render.rs`) into a `CAMetalLayer` in a native window of its own (`window.rs`), or into an
//! offscreen texture (headless measurement). No pixel is copied on the way: the decoder's
//! IOSurface is the shader's texture through a `CVMetalTextureCache`.

mod decoder;
mod render;
mod sys;
mod window;

pub use decoder::Decoder;
pub use render::Presenter;

use crate::color::Matrix;
use sys::*;

/// Seconds on the host clock (`CACurrentMediaTime`), the clock Metal reports present times in.
pub fn now() -> f64 {
  // SAFETY: a plain C call.
  unsafe { CACurrentMediaTime() }
}

/// Whether this is the process's main thread (the one AppKit belongs to).
pub fn is_main_thread() -> bool {
  objc2::MainThreadMarker::new().is_some()
}

/// A decoded picture: a retained `CVPixelBuffer` and when its frame was pushed and decoded.
pub struct Frame {
  buffer: CVPixelBufferRef,
  pub push_time: f64,
  pub decoded_time: f64,
}

// SAFETY: CVPixelBuffers are reference counted atomically and immutable once decoded.
unsafe impl Send for Frame {}

impl Frame {
  /// Retains `buffer`.
  ///
  /// # Safety
  /// `buffer` must be a valid `CVPixelBuffer`.
  pub unsafe fn retain(buffer: CVPixelBufferRef, push_time: f64, decoded_time: f64) -> Self {
    // SAFETY: the caller's.
    unsafe { CVPixelBufferRetain(buffer) };
    Self {
      buffer,
      push_time,
      decoded_time,
    }
  }

  pub fn buffer(&self) -> CVPixelBufferRef {
    self.buffer
  }

  pub fn width(&self) -> u32 {
    // SAFETY: a valid buffer.
    unsafe { CVPixelBufferGetWidth(self.buffer) as u32 }
  }

  pub fn height(&self) -> u32 {
    // SAFETY: a valid buffer.
    unsafe { CVPixelBufferGetHeight(self.buffer) as u32 }
  }

  /// The picture's matrix coefficients (its `YCbCrMatrix` attachment; BT.709 when absent).
  pub fn matrix(&self) -> Matrix {
    // SAFETY: a valid buffer; the attachment is copied (+1) and released.
    unsafe {
      let value = CVBufferCopyAttachment(
        self.buffer,
        kCVImageBufferYCbCrMatrixKey,
        std::ptr::null_mut(),
      );
      if value.is_null() {
        return Matrix::Bt709;
      }
      let value = Cf(value);
      if CFEqual(value.as_ptr(), kCVImageBufferYCbCrMatrix_ITU_R_601_4) != 0 {
        Matrix::Bt601
      } else if CFEqual(value.as_ptr(), kCVImageBufferYCbCrMatrix_ITU_R_2020) != 0 {
        Matrix::Bt2020
      } else {
        Matrix::Bt709
      }
    }
  }

  /// Whether the picture is full range (`'420f'`) rather than video range.
  pub fn full_range(&self) -> bool {
    // SAFETY: a valid buffer.
    unsafe {
      CVPixelBufferGetPixelFormatType(self.buffer) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    }
  }
}

impl Drop for Frame {
  fn drop(&mut self) {
    // SAFETY: we hold one reference.
    unsafe { CVPixelBufferRelease(self.buffer) };
  }
}

/// The mean of the picture's luma (every 4th sample of every 4th row) and an FNV-1a hash of the
/// same samples: what the decode tests compare. Reads the IOSurface on the CPU, so it runs only
/// with `RTCV_FLAG_INSPECT`.
pub fn inspect(frame: &Frame) -> (f64, u32) {
  let buffer = frame.buffer;
  // SAFETY: the base address is valid between lock and unlock; the loops stay inside the plane.
  unsafe {
    if CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) != 0 {
      return (0.0, 0);
    }
    let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) as *const u8;
    let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
    let width = CVPixelBufferGetWidthOfPlane(buffer, 0);
    let height = CVPixelBufferGetHeightOfPlane(buffer, 0);
    let mut sum = 0u64;
    let mut count = 0u64;
    let mut hash = 0x811c_9dc5u32;
    if !base.is_null() {
      for y in (0..height).step_by(4) {
        let row = base.add(y * stride);
        for x in (0..width).step_by(4) {
          let v = *row.add(x);
          sum += u64::from(v);
          count += 1;
          hash = (hash ^ u32::from(v)).wrapping_mul(0x0100_0193);
        }
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    (
      if count == 0 {
        0.0
      } else {
        sum as f64 / count as f64
      },
      hash,
    )
  }
}
