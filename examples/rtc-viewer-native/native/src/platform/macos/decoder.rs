//! VideoToolbox decode: an access unit in, a `CVPixelBuffer` (IOSurface-backed, Metal-compatible
//! NV12) out on VideoToolbox's own callback thread, handed straight to [`Shared::on_decoded`].
//!
//! - H.264 / H.265: the parameter sets of each key frame make the format description; the rest
//!   of the access unit becomes one length-prefixed sample (`crate::annexb`). A change of
//!   parameter sets the session can't take (a new size) makes a new session.
//! - VP9: the key frame's header gives the size and the `vpcC` record; the supplemental VP9
//!   decoder is registered first (macOS 11+; hardware on Apple silicon).
//! - AV1 / VP8: refused at creation (`Error::UnsupportedCodec`). WebRTC's receiver here delivers
//!   no AV1 frames (the engine has no AV1 depacketizer) and VideoToolbox has no VP8 decoder.
//!
//! Decoding is asynchronous with the real-time hint set, so `rtcv_push` returns as soon as the
//! frame is queued (the JavaScript thread never waits for the hardware) and pictures come out in
//! decode order with no reordering delay (WebRTC streams have no B-frames).

use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;

use super::sys::*;
use super::{Frame, now};
use crate::annexb::{self, ParamSets};
use crate::codec::Codec;
use crate::viewer::{Error, PushOutcome, Shared};
use crate::vp9;

/// What the output callback needs: the viewer's shared state. Boxed so its address is stable
/// for the session's lifetime.
struct CallbackCtx {
  shared: Arc<Shared>,
}

/// A VideoToolbox decompression session and the stream state around it.
pub struct Decoder {
  codec: Codec,
  shared: Arc<Shared>,
  ctx: Box<CallbackCtx>,
  session: VTDecompressionSessionRef,
  format: Option<Cf>,
  params: ParamSets,
  vp9_key: Option<vp9::KeyFrameInfo>,
}

// SAFETY: the session is used only behind the viewer's decoder mutex; VideoToolbox sessions may be
// driven from any thread.
unsafe impl Send for Decoder {}

impl Decoder {
  /// A decoder for `codec`. The session is made at the first key frame.
  pub fn new(codec: Codec, shared: Arc<Shared>) -> Result<Self, Error> {
    match codec {
      Codec::H264 | Codec::H265 => {}
      Codec::Vp9 => {
        // SAFETY: plain C calls with a codec constant.
        unsafe { VTRegisterSupplementalVideoDecoderIfAvailable(kCMVideoCodecType_VP9) };
      }
      Codec::Av1 | Codec::Vp8 => return Err(Error::UnsupportedCodec),
    }
    Ok(Self {
      codec,
      ctx: Box::new(CallbackCtx {
        shared: shared.clone(),
      }),
      shared,
      session: ptr::null_mut(),
      format: None,
      params: ParamSets::default(),
      vp9_key: None,
    })
  }

  /// Queues one encoded frame. `push_time` is when `rtcv_push` got it ([`now`]).
  pub fn decode(&mut self, data: &[u8], push_time: f64) -> Result<PushOutcome, Error> {
    let sample = match self.codec {
      Codec::H264 | Codec::H265 => {
        let unit = annexb::to_sample(self.codec, data, &mut self.params);
        if unit.params_changed && self.params.complete(self.codec) {
          self.set_format(self.parameter_set_format()?)?;
        }
        if unit.sample.is_empty() {
          // Only parameter sets: nothing to decode yet.
          return Ok(PushOutcome::Queued);
        }
        unit.sample
      }
      Codec::Vp9 => {
        if let Some(info) = vp9::parse_key_frame(data)
          && self.vp9_key != Some(info)
        {
          self.vp9_key = Some(info);
          self.set_format(vp9_format(&info)?)?;
        }
        data.to_vec()
      }
      Codec::Av1 | Codec::Vp8 => return Err(Error::UnsupportedCodec),
    };
    if self.session.is_null() {
      return Ok(PushOutcome::WaitingForKeyFrame);
    }
    self.submit(&sample, push_time)
  }

  /// Waits for every queued frame to come out.
  pub fn flush(&mut self) {
    if !self.session.is_null() {
      // SAFETY: a live session.
      unsafe { VTDecompressionSessionWaitForAsynchronousFrames(self.session) };
    }
  }

  fn parameter_set_format(&self) -> Result<Cf, Error> {
    let sets = self.params.ordered();
    let pointers: Vec<*const u8> = sets.iter().map(|s| s.as_ptr()).collect();
    let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
    let mut format: CMFormatDescriptionRef = ptr::null();
    // SAFETY: the pointer / size arrays describe `sets`, which outlive the call.
    let status = unsafe {
      match self.codec {
        Codec::H264 => CMVideoFormatDescriptionCreateFromH264ParameterSets(
          ptr::null(),
          sets.len(),
          pointers.as_ptr(),
          sizes.as_ptr(),
          4,
          &mut format,
        ),
        _ => CMVideoFormatDescriptionCreateFromHEVCParameterSets(
          ptr::null(),
          sets.len(),
          pointers.as_ptr(),
          sizes.as_ptr(),
          4,
          ptr::null(),
          &mut format,
        ),
      }
    };
    if status != 0 {
      return Err(Error::Platform(status));
    }
    Ok(Cf(format))
  }

  /// Takes a new format description, keeping the session when it can decode it.
  fn set_format(&mut self, format: Cf) -> Result<(), Error> {
    // SAFETY: a CMVideoFormatDescription.
    let dims = unsafe { CMVideoFormatDescriptionGetDimensions(format.as_ptr()) };
    {
      let mut stats = self.shared.lock_stats();
      stats.width = dims.width.max(0) as u32;
      stats.height = dims.height.max(0) as u32;
    }
    // SAFETY: a live session and a format description.
    let keep = !self.session.is_null()
      && unsafe { VTDecompressionSessionCanAcceptFormatDescription(self.session, format.as_ptr()) }
        != 0;
    if !keep {
      self.end_session();
      self.session = self.create_session(&format)?;
    }
    self.format = Some(format);
    Ok(())
  }

  fn create_session(&self, format: &Cf) -> Result<VTDecompressionSessionRef, Error> {
    // SAFETY: the keys are the frameworks' constant strings; the dictionaries retain what they
    // hold; the callback context outlives the session (it is dropped after `end_session`).
    unsafe {
      let spec = dict();
      dict_set(
        &spec,
        kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
        kCFBooleanTrue,
      );
      let attrs = dict();
      // NV12 in video range: the hardware decoders' native output, so no conversion pass.
      let format_type = number(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange as i32);
      dict_set(
        &attrs,
        kCVPixelBufferPixelFormatTypeKey,
        format_type.as_ptr(),
      );
      dict_set(&attrs, kCVPixelBufferMetalCompatibilityKey, kCFBooleanTrue);
      let surface = dict();
      dict_set(
        &attrs,
        kCVPixelBufferIOSurfacePropertiesKey,
        surface.as_ptr(),
      );
      let record = VTDecompressionOutputCallbackRecord {
        callback: Some(output_callback),
        ref_con: (&raw const *self.ctx).cast_mut().cast(),
      };
      let mut session: VTDecompressionSessionRef = ptr::null_mut();
      let status = VTDecompressionSessionCreate(
        ptr::null(),
        format.as_ptr(),
        spec.as_ptr(),
        attrs.as_ptr(),
        &record,
        &mut session,
      );
      if status != 0 {
        return Err(Error::Platform(status));
      }
      VTSessionSetProperty(
        session,
        kVTDecompressionPropertyKey_RealTime,
        kCFBooleanTrue,
      );
      let mut hw: CFTypeRef = ptr::null();
      let hw_status = VTSessionCopyProperty(
        session,
        kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
        ptr::null(),
        (&raw mut hw).cast(),
      );
      let mut stats = self.shared.lock_stats();
      stats.hardware = if hw_status == 0 && !hw.is_null() {
        let on = CFBooleanGetValue(hw) != 0;
        CFRelease(hw);
        i8::from(on)
      } else {
        -1
      };
      Ok(session)
    }
  }

  fn submit(&mut self, sample: &[u8], push_time: f64) -> Result<PushOutcome, Error> {
    let format = self.format.as_ref().ok_or(Error::Platform(-1))?;
    // SAFETY: the block buffer allocates and owns its memory, which `sample` is copied into; the
    // sample buffer retains the block buffer; both are released here after the decode call (the
    // decoder retains what it keeps).
    unsafe {
      let mut block: CMBlockBufferRef = ptr::null_mut();
      let status = CMBlockBufferCreateWithMemoryBlock(
        ptr::null(),
        ptr::null_mut(),
        sample.len(),
        ptr::null(),
        ptr::null(),
        0,
        sample.len(),
        kCMBlockBufferAssureMemoryNowFlag,
        &mut block,
      );
      if status != 0 {
        return Err(Error::Platform(status));
      }
      let block = Cf(block.cast_const());
      let status =
        CMBlockBufferReplaceDataBytes(sample.as_ptr().cast(), block.0.cast_mut(), 0, sample.len());
      if status != 0 {
        return Err(Error::Platform(status));
      }
      let size = sample.len();
      let mut buffer: CMSampleBufferRef = ptr::null_mut();
      let status = CMSampleBufferCreateReady(
        ptr::null(),
        block.0.cast_mut(),
        format.as_ptr(),
        1,
        0,
        ptr::null(),
        1,
        &size,
        &mut buffer,
      );
      if status != 0 {
        return Err(Error::Platform(status));
      }
      let buffer = Cf(buffer.cast_const());
      // The push time rides in the frame's refcon as whole microseconds: no allocation that a
      // failed decode would have to free.
      let refcon = (push_time * 1e6) as u64 as usize as *mut c_void;
      let mut info = 0u32;
      let status = VTDecompressionSessionDecodeFrame(
        self.session,
        buffer.0.cast_mut(),
        kVTDecodeFrame_EnableAsynchronousDecompression,
        refcon,
        &mut info,
      );
      if status != 0 {
        return Err(Error::Platform(status));
      }
    }
    Ok(PushOutcome::Queued)
  }

  fn end_session(&mut self) {
    if self.session.is_null() {
      return;
    }
    // SAFETY: a live session we own; after Invalidate no callback runs.
    unsafe {
      VTDecompressionSessionWaitForAsynchronousFrames(self.session);
      VTDecompressionSessionInvalidate(self.session);
      CFRelease(self.session.cast_const());
    }
    self.session = ptr::null_mut();
  }
}

impl Drop for Decoder {
  fn drop(&mut self) {
    self.end_session();
  }
}

/// A VP9 format description: the size and the `vpcC` atom.
fn vp9_format(info: &vp9::KeyFrameInfo) -> Result<Cf, Error> {
  let vpcc = info.vpcc();
  // SAFETY: the dictionaries retain the data and key they are given.
  unsafe {
    let atom = Cf(CFDataCreate(
      ptr::null(),
      vpcc.as_ptr(),
      vpcc.len() as isize,
    ));
    let key = Cf(CFStringCreateWithCString(
      ptr::null(),
      c"vpcC".as_ptr(),
      kCFStringEncodingUTF8,
    ));
    let atoms = dict();
    dict_set(&atoms, key.as_ptr(), atom.as_ptr());
    let extensions = dict();
    dict_set(
      &extensions,
      kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms,
      atoms.as_ptr(),
    );
    let mut format: CMFormatDescriptionRef = ptr::null();
    let status = CMVideoFormatDescriptionCreate(
      ptr::null(),
      kCMVideoCodecType_VP9,
      info.width as i32,
      info.height as i32,
      extensions.as_ptr(),
      &mut format,
    );
    if status != 0 {
      return Err(Error::Platform(status));
    }
    Ok(Cf(format))
  }
}

/// VideoToolbox's output callback, on its own thread.
unsafe extern "C" fn output_callback(
  ref_con: *mut c_void,
  frame_ref_con: *mut c_void,
  status: OSStatus,
  info_flags: u32,
  image: CVPixelBufferRef,
  _pts: CMTime,
  _duration: CMTime,
) {
  // SAFETY: `ref_con` is the decoder's boxed context, alive while its session is.
  let ctx = unsafe { &*(ref_con as *const CallbackCtx) };
  let push_time = frame_ref_con as usize as f64 / 1e6;
  if status != 0 || image.is_null() || info_flags & kVTDecodeInfo_FrameDropped != 0 {
    ctx.shared.on_decode_error(status);
    return;
  }
  // SAFETY: the callback's image is valid for the call; retaining it keeps it for the presenter.
  let frame = unsafe { Frame::retain(image, push_time, now()) };
  ctx.shared.on_decoded(frame);
}
