//! The C APIs the macOS backend calls: Core Foundation, Core Media, Core Video and VideoToolbox.
//! Declared by hand (the handful used) rather than through generated crates. Every Core
//! Foundation type here is a `CFTypeRef` underneath and is released with `CFRelease`.

#![allow(non_upper_case_globals, non_snake_case, dead_code)]

use std::ffi::{c_char, c_void};

pub type OSStatus = i32;
pub type Boolean = u8;
pub type CFTypeRef = *const c_void;
pub type CFAllocatorRef = *const c_void;
pub type CFStringRef = *const c_void;
pub type CFDictionaryRef = *const c_void;
pub type CFMutableDictionaryRef = *mut c_void;
pub type CMFormatDescriptionRef = *const c_void;
pub type CMBlockBufferRef = *mut c_void;
pub type CMSampleBufferRef = *mut c_void;
pub type CVPixelBufferRef = *mut c_void;
pub type CVMetalTextureCacheRef = *mut c_void;
pub type CVMetalTextureRef = *mut c_void;
pub type VTDecompressionSessionRef = *mut c_void;

#[repr(C)]
pub struct CFDictionaryKeyCallBacks {
  version: isize,
  retain: *const c_void,
  release: *const c_void,
  copy_description: *const c_void,
  equal: *const c_void,
  hash: *const c_void,
}

#[repr(C)]
pub struct CFDictionaryValueCallBacks {
  version: isize,
  retain: *const c_void,
  release: *const c_void,
  copy_description: *const c_void,
  equal: *const c_void,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CMTime {
  pub value: i64,
  pub timescale: i32,
  pub flags: u32,
  pub epoch: i64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CMVideoDimensions {
  pub width: i32,
  pub height: i32,
}

pub type VTDecompressionOutputCallback = unsafe extern "C" fn(
  decompression_output_ref_con: *mut c_void,
  source_frame_ref_con: *mut c_void,
  status: OSStatus,
  info_flags: u32,
  image_buffer: CVPixelBufferRef,
  presentation_time_stamp: CMTime,
  presentation_duration: CMTime,
);

#[repr(C)]
pub struct VTDecompressionOutputCallbackRecord {
  pub callback: Option<VTDecompressionOutputCallback>,
  pub ref_con: *mut c_void,
}

pub const kCFNumberSInt32Type: isize = 3;
pub const kCFStringEncodingUTF8: u32 = 0x0800_0100;
pub const kCMBlockBufferAssureMemoryNowFlag: u32 = 1;
pub const kCVPixelBufferLock_ReadOnly: u64 = 1;
/// `'420v'`: bi-planar 4:2:0, 8-bit, video range (what the decoders put out natively).
pub const kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: u32 = 0x3432_3076;
/// `'420f'`: the same, full range.
pub const kCVPixelFormatType_420YpCbCr8BiPlanarFullRange: u32 = 0x3432_3066;
pub const kVTDecodeFrame_EnableAsynchronousDecompression: u32 = 1;
pub const kVTDecodeInfo_FrameDropped: u32 = 1 << 1;
pub const kCMVideoCodecType_H264: u32 = u32::from_be_bytes(*b"avc1");
pub const kCMVideoCodecType_HEVC: u32 = u32::from_be_bytes(*b"hvc1");
pub const kCMVideoCodecType_VP9: u32 = u32::from_be_bytes(*b"vp09");
pub const kCMVideoCodecType_AV1: u32 = u32::from_be_bytes(*b"av01");

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
  pub static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
  pub static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
  pub static kCFBooleanTrue: CFTypeRef;
  pub static kCFBooleanFalse: CFTypeRef;
  pub fn CFRelease(cf: CFTypeRef);
  pub fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
  pub fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> Boolean;
  pub fn CFBooleanGetValue(boolean: CFTypeRef) -> Boolean;
  pub fn CFDictionaryCreateMutable(
    allocator: CFAllocatorRef,
    capacity: isize,
    key_callbacks: *const CFDictionaryKeyCallBacks,
    value_callbacks: *const CFDictionaryValueCallBacks,
  ) -> CFMutableDictionaryRef;
  pub fn CFDictionarySetValue(
    dict: CFMutableDictionaryRef,
    key: *const c_void,
    value: *const c_void,
  );
  pub fn CFNumberCreate(
    allocator: CFAllocatorRef,
    the_type: isize,
    value: *const c_void,
  ) -> CFTypeRef;
  pub fn CFDataCreate(allocator: CFAllocatorRef, bytes: *const u8, length: isize) -> CFTypeRef;
  pub fn CFStringCreateWithCString(
    allocator: CFAllocatorRef,
    c_str: *const c_char,
    encoding: u32,
  ) -> CFStringRef;
}

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
  pub static kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms: CFStringRef;
  pub fn CMVideoFormatDescriptionCreateFromH264ParameterSets(
    allocator: CFAllocatorRef,
    parameter_set_count: usize,
    parameter_set_pointers: *const *const u8,
    parameter_set_sizes: *const usize,
    nal_unit_header_length: i32,
    format_description_out: *mut CMFormatDescriptionRef,
  ) -> OSStatus;
  pub fn CMVideoFormatDescriptionCreateFromHEVCParameterSets(
    allocator: CFAllocatorRef,
    parameter_set_count: usize,
    parameter_set_pointers: *const *const u8,
    parameter_set_sizes: *const usize,
    nal_unit_header_length: i32,
    extensions: CFDictionaryRef,
    format_description_out: *mut CMFormatDescriptionRef,
  ) -> OSStatus;
  pub fn CMVideoFormatDescriptionCreate(
    allocator: CFAllocatorRef,
    codec_type: u32,
    width: i32,
    height: i32,
    extensions: CFDictionaryRef,
    format_description_out: *mut CMFormatDescriptionRef,
  ) -> OSStatus;
  pub fn CMVideoFormatDescriptionGetDimensions(desc: CMFormatDescriptionRef) -> CMVideoDimensions;
  pub fn CMBlockBufferCreateWithMemoryBlock(
    allocator: CFAllocatorRef,
    memory_block: *mut c_void,
    block_length: usize,
    block_allocator: CFAllocatorRef,
    custom_block_source: *const c_void,
    offset_to_data: usize,
    data_length: usize,
    flags: u32,
    block_buffer_out: *mut CMBlockBufferRef,
  ) -> OSStatus;
  pub fn CMBlockBufferReplaceDataBytes(
    source_bytes: *const c_void,
    destination_buffer: CMBlockBufferRef,
    offset_into_destination: usize,
    data_length: usize,
  ) -> OSStatus;
  pub fn CMSampleBufferCreateReady(
    allocator: CFAllocatorRef,
    data_buffer: CMBlockBufferRef,
    format_description: CMFormatDescriptionRef,
    num_samples: isize,
    num_sample_timing_entries: isize,
    sample_timing_array: *const c_void,
    num_sample_size_entries: isize,
    sample_size_array: *const usize,
    sample_buffer_out: *mut CMSampleBufferRef,
  ) -> OSStatus;
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
  pub static kCVPixelBufferPixelFormatTypeKey: CFStringRef;
  pub static kCVPixelBufferMetalCompatibilityKey: CFStringRef;
  pub static kCVPixelBufferIOSurfacePropertiesKey: CFStringRef;
  pub static kCVImageBufferYCbCrMatrixKey: CFStringRef;
  pub static kCVImageBufferYCbCrMatrix_ITU_R_709_2: CFStringRef;
  pub static kCVImageBufferYCbCrMatrix_ITU_R_601_4: CFStringRef;
  pub static kCVImageBufferYCbCrMatrix_ITU_R_2020: CFStringRef;
  pub fn CVPixelBufferRetain(buffer: CVPixelBufferRef) -> CVPixelBufferRef;
  pub fn CVPixelBufferRelease(buffer: CVPixelBufferRef);
  pub fn CVPixelBufferGetWidth(buffer: CVPixelBufferRef) -> usize;
  pub fn CVPixelBufferGetHeight(buffer: CVPixelBufferRef) -> usize;
  pub fn CVPixelBufferGetPixelFormatType(buffer: CVPixelBufferRef) -> u32;
  pub fn CVPixelBufferGetWidthOfPlane(buffer: CVPixelBufferRef, plane: usize) -> usize;
  pub fn CVPixelBufferGetHeightOfPlane(buffer: CVPixelBufferRef, plane: usize) -> usize;
  pub fn CVPixelBufferLockBaseAddress(buffer: CVPixelBufferRef, flags: u64) -> i32;
  pub fn CVPixelBufferUnlockBaseAddress(buffer: CVPixelBufferRef, flags: u64) -> i32;
  pub fn CVPixelBufferGetBaseAddressOfPlane(buffer: CVPixelBufferRef, plane: usize) -> *mut c_void;
  pub fn CVPixelBufferGetBytesPerRowOfPlane(buffer: CVPixelBufferRef, plane: usize) -> usize;
  pub fn CVBufferCopyAttachment(
    buffer: CVPixelBufferRef,
    key: CFStringRef,
    attachment_mode: *mut u32,
  ) -> CFTypeRef;
  pub fn CVMetalTextureCacheCreate(
    allocator: CFAllocatorRef,
    cache_attributes: CFDictionaryRef,
    metal_device: *mut c_void,
    texture_attributes: CFDictionaryRef,
    cache_out: *mut CVMetalTextureCacheRef,
  ) -> i32;
  pub fn CVMetalTextureCacheCreateTextureFromImage(
    allocator: CFAllocatorRef,
    texture_cache: CVMetalTextureCacheRef,
    source_image: CVPixelBufferRef,
    texture_attributes: CFDictionaryRef,
    pixel_format: usize,
    width: usize,
    height: usize,
    plane_index: usize,
    texture_out: *mut CVMetalTextureRef,
  ) -> i32;
  pub fn CVMetalTextureGetTexture(texture: CVMetalTextureRef) -> *mut c_void;
  pub fn CVMetalTextureCacheFlush(texture_cache: CVMetalTextureCacheRef, options: u64);
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
  pub static kVTDecompressionPropertyKey_RealTime: CFStringRef;
  pub static kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder: CFStringRef;
  pub static kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: CFStringRef;
  pub fn VTDecompressionSessionCreate(
    allocator: CFAllocatorRef,
    video_format_description: CMFormatDescriptionRef,
    video_decoder_specification: CFDictionaryRef,
    destination_image_buffer_attributes: CFDictionaryRef,
    output_callback: *const VTDecompressionOutputCallbackRecord,
    decompression_session_out: *mut VTDecompressionSessionRef,
  ) -> OSStatus;
  pub fn VTDecompressionSessionDecodeFrame(
    session: VTDecompressionSessionRef,
    sample_buffer: CMSampleBufferRef,
    decode_flags: u32,
    source_frame_ref_con: *mut c_void,
    info_flags_out: *mut u32,
  ) -> OSStatus;
  pub fn VTDecompressionSessionWaitForAsynchronousFrames(
    session: VTDecompressionSessionRef,
  ) -> OSStatus;
  pub fn VTDecompressionSessionInvalidate(session: VTDecompressionSessionRef);
  pub fn VTDecompressionSessionCanAcceptFormatDescription(
    session: VTDecompressionSessionRef,
    new_format_desc: CMFormatDescriptionRef,
  ) -> Boolean;
  pub fn VTSessionSetProperty(session: *mut c_void, key: CFStringRef, value: CFTypeRef)
  -> OSStatus;
  pub fn VTSessionCopyProperty(
    session: *mut c_void,
    key: CFStringRef,
    allocator: CFAllocatorRef,
    value_out: *mut c_void,
  ) -> OSStatus;
  pub fn VTRegisterSupplementalVideoDecoderIfAvailable(codec_type: u32);
  pub fn VTIsHardwareDecodeSupported(codec_type: u32) -> Boolean;
}

#[link(name = "QuartzCore", kind = "framework")]
unsafe extern "C" {
  /// Seconds on the host clock (`mach_absolute_time`), the clock `MTLDrawable.presentedTime` and
  /// `MTLCommandBuffer.GPUEndTime` use.
  pub fn CACurrentMediaTime() -> f64;
}

/// An owned Core Foundation object, released on drop.
pub struct Cf(pub CFTypeRef);

impl Cf {
  pub fn as_ptr(&self) -> CFTypeRef {
    self.0
  }
}

impl Drop for Cf {
  fn drop(&mut self) {
    if !self.0.is_null() {
      // SAFETY: we own one reference to this object.
      unsafe { CFRelease(self.0) };
    }
  }
}

// SAFETY: Core Foundation objects are reference counted atomically; the ones held here are
// immutable after creation.
unsafe impl Send for Cf {}
// SAFETY: as above.
unsafe impl Sync for Cf {}

/// A mutable `CFDictionary` with CF-typed keys and values.
pub fn dict() -> Cf {
  // SAFETY: the callbacks are the system's statics.
  Cf(unsafe {
    CFDictionaryCreateMutable(
      std::ptr::null(),
      0,
      &raw const kCFTypeDictionaryKeyCallBacks,
      &raw const kCFTypeDictionaryValueCallBacks,
    )
  })
}

/// Sets `key` to `value` in a dictionary from [`dict`] (both retained by it).
pub fn dict_set(dict: &Cf, key: CFTypeRef, value: CFTypeRef) {
  // SAFETY: `dict` is a mutable dictionary; key and value are CF objects.
  unsafe { CFDictionarySetValue(dict.0 as CFMutableDictionaryRef, key, value) };
}

/// A `CFNumber` holding a 32-bit integer.
pub fn number(value: i32) -> Cf {
  // SAFETY: `value` outlives the call, which copies it.
  Cf(unsafe {
    CFNumberCreate(
      std::ptr::null(),
      kCFNumberSInt32Type,
      (&raw const value).cast(),
    )
  })
}
