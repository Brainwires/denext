//! The Metal presenter: a render thread takes the newest decoded picture from the mailbox, wraps
//! its two IOSurface planes as Metal textures (`CVMetalTextureCache`, no copy), converts Y'CbCr to
//! RGB in one full-screen triangle (letterboxed to the picture's aspect) and presents.
//!
//! Why `CAMetalLayer` (and not `AVSampleBufferDisplayLayer`):
//! - latency control: `displaySyncEnabled = false` and two drawables mean a picture is handed to
//!   the compositor the moment it is drawn, not queued behind a timebase; with
//!   `AVSampleBufferDisplayLayer` the layer schedules display itself;
//! - measurement: every drawable reports when it actually reached the glass
//!   (`MTLDrawable.presentedTime`), so `stats().present` is a measured number, not an estimate;
//!   `AVSampleBufferDisplayLayer` reports no per-frame display time;
//! - the same shape on every OS: decode → GPU texture → swap chain, which is what Windows (DXGI
//!   flip model) and Linux (Vulkan) do too.
//!
//! The offscreen variant draws into a private texture of a fixed size and reports the GPU's
//! completion time instead: the same decode → texture → draw path, measurable without a window.

use std::cell::Cell;
use std::ptr::{self, NonNull};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::NSString;
use objc2_metal::{
  MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
  MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLLibrary, MTLLoadAction, MTLPixelFormat,
  MTLPrimitiveType, MTLRenderCommandEncoder, MTLRenderPassDescriptor, MTLRenderPipelineDescriptor,
  MTLRenderPipelineState, MTLStorageMode, MTLStoreAction, MTLTexture, MTLTextureDescriptor,
  MTLTextureUsage, MTLViewport,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};

use super::sys::*;
use super::window::Window;
use super::{Frame, now};
use crate::color;
use crate::viewer::{Error, Shared};

const SHADER: &str = r#"
#include <metal_stdlib>
using namespace metal;
struct Vary { float4 position [[position]]; float2 uv; };
vertex Vary vs(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  Vary out;
  out.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = float2(p.x, 1.0 - p.y);
  return out;
}
fragment float4 fs(Vary in [[stage_in]],
                   texture2d<float> luma [[texture(0)]],
                   texture2d<float> chroma [[texture(1)]],
                   constant float4x4 &yuv_to_rgb [[buffer(0)]]) {
  constexpr sampler s(filter::linear, address::clamp_to_edge);
  float4 yuv = float4(luma.sample(s, in.uv).r, chroma.sample(s, in.uv).rg, 1.0);
  return float4((yuv_to_rgb * yuv).rgb, 1.0);
}
"#;

type Device = ProtocolObject<dyn MTLDevice>;
type Texture = ProtocolObject<dyn MTLTexture>;

/// A Metal object handed to the render thread. Metal devices, queues, pipelines and
/// `CAMetalLayer` drawables may be used from any thread.
struct SendBox<T>(T);
// SAFETY: see above; each value is used by one thread at a time.
unsafe impl<T> Send for SendBox<T> {}

impl<T> SendBox<T> {
  /// Takes the value out (a method, so a closure captures the whole box, not its field).
  fn into_inner(self) -> T {
    self.0
  }
}

/// The device-side state: the pipeline and the texture cache.
struct Renderer {
  device: Retained<Device>,
  queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
  pipeline: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
  cache: Cf,
}

impl Renderer {
  fn new(device: Retained<Device>) -> Result<Self, Error> {
    let queue = device.newCommandQueue().ok_or(Error::NoDevice)?;
    let library = device
      .newLibraryWithSource_options_error(&NSString::from_str(SHADER), None)
      .map_err(|_| Error::Platform(-2))?;
    let vs = library
      .newFunctionWithName(&NSString::from_str("vs"))
      .ok_or(Error::Platform(-2))?;
    let fs = library
      .newFunctionWithName(&NSString::from_str("fs"))
      .ok_or(Error::Platform(-2))?;
    let desc = MTLRenderPipelineDescriptor::new();
    desc.setVertexFunction(Some(&vs));
    desc.setFragmentFunction(Some(&fs));
    // SAFETY: index 0 exists.
    unsafe { desc.colorAttachments().objectAtIndexedSubscript(0) }
      .setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    let pipeline = device
      .newRenderPipelineStateWithDescriptor_error(&desc)
      .map_err(|_| Error::Platform(-3))?;
    let mut cache: CVMetalTextureCacheRef = ptr::null_mut();
    // SAFETY: the device is a live MTLDevice; the cache retains it.
    let status = unsafe {
      CVMetalTextureCacheCreate(
        ptr::null(),
        ptr::null(),
        Retained::as_ptr(&device) as *mut _,
        ptr::null(),
        &mut cache,
      )
    };
    if status != 0 {
      return Err(Error::Platform(status));
    }
    Ok(Self {
      device,
      queue,
      pipeline,
      cache: Cf(cache.cast_const()),
    })
  }

  /// One plane of `frame` as a Metal texture (the CVMetalTexture must outlive the GPU's use).
  fn plane(&self, frame: &Frame, plane: usize, format: MTLPixelFormat) -> Option<(Cf, &Texture)> {
    let buffer = frame.buffer();
    // SAFETY: a valid pixel buffer and cache; the texture belongs to the returned CVMetalTexture.
    unsafe {
      let width = CVPixelBufferGetWidthOfPlane(buffer, plane);
      let height = CVPixelBufferGetHeightOfPlane(buffer, plane);
      let mut texture: CVMetalTextureRef = ptr::null_mut();
      let status = CVMetalTextureCacheCreateTextureFromImage(
        ptr::null(),
        self.cache.0.cast_mut(),
        buffer,
        ptr::null(),
        format.0,
        width,
        height,
        plane,
        &mut texture,
      );
      if status != 0 || texture.is_null() {
        return None;
      }
      let metal = CVMetalTextureGetTexture(texture) as *const Texture;
      Some((Cf(texture.cast_const()), metal.as_ref()?))
    }
  }

  /// Encodes drawing `frame` into `target` (aspect-fit, black bars). Returns what must live until
  /// the command buffer completes.
  fn encode(
    &self,
    command: &ProtocolObject<dyn MTLCommandBuffer>,
    target: &Texture,
    frame: &Frame,
  ) -> Option<(Cf, Cf)> {
    let (y_ref, y) = self.plane(frame, 0, MTLPixelFormat::R8Unorm)?;
    let (c_ref, c) = self.plane(frame, 1, MTLPixelFormat::RG8Unorm)?;
    let pass = MTLRenderPassDescriptor::new();
    // SAFETY: index 0 exists.
    let attachment = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
    attachment.setTexture(Some(target));
    attachment.setLoadAction(MTLLoadAction::Clear);
    attachment.setStoreAction(MTLStoreAction::Store);
    attachment.setClearColor(MTLClearColor {
      red: 0.0,
      green: 0.0,
      blue: 0.0,
      alpha: 1.0,
    });
    let encoder = command.renderCommandEncoderWithDescriptor(&pass)?;
    encoder.setRenderPipelineState(&self.pipeline);
    encoder.setViewport(fit(
      target.width() as f64,
      target.height() as f64,
      f64::from(frame.width()),
      f64::from(frame.height()),
    ));
    let matrix = color::yuv_to_rgb(frame.matrix(), frame.full_range());
    // SAFETY: the textures are live; the 64 matrix bytes are copied by the call.
    unsafe {
      encoder.setFragmentTexture_atIndex(Some(y), 0);
      encoder.setFragmentTexture_atIndex(Some(c), 1);
      encoder.setFragmentBytes_length_atIndex(
        NonNull::new(matrix.as_ptr() as *mut _).unwrap(),
        std::mem::size_of_val(&matrix),
        0,
      );
      encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
    }
    encoder.endEncoding();
    Some((y_ref, c_ref))
  }
}

/// The viewport that fits a `fw`×`fh` picture in a `tw`×`th` target, centred.
fn fit(tw: f64, th: f64, fw: f64, fh: f64) -> MTLViewport {
  let scale = if fw > 0.0 && fh > 0.0 {
    (tw / fw).min(th / fh)
  } else {
    1.0
  };
  let (w, h) = (fw * scale, fh * scale);
  MTLViewport {
    originX: (tw - w) / 2.0,
    originY: (th - h) / 2.0,
    width: w,
    height: h,
    znear: 0.0,
    zfar: 1.0,
  }
}

/// Where the render thread draws.
enum Target {
  Layer(Retained<CAMetalLayer>),
  Offscreen(Retained<Texture>),
}

/// A running presenter: its render thread and, for a window, the window.
pub struct Presenter {
  shared: Arc<Shared>,
  thread: Option<JoinHandle<()>>,
  window: Option<Window>,
}

impl Presenter {
  /// A presenter drawing into an offscreen texture.
  pub fn offscreen(shared: Arc<Shared>, width: u32, height: u32) -> Result<Self, Error> {
    let device = MTLCreateSystemDefaultDevice().ok_or(Error::NoDevice)?;
    let renderer = Renderer::new(device)?;
    // SAFETY: a plain descriptor constructor.
    let desc = unsafe {
      MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
        MTLPixelFormat::BGRA8Unorm,
        width as usize,
        height as usize,
        false,
      )
    };
    desc.setUsage(MTLTextureUsage::RenderTarget);
    desc.setStorageMode(MTLStorageMode::Private);
    let texture = renderer
      .device
      .newTextureWithDescriptor(&desc)
      .ok_or(Error::NoDevice)?;
    Ok(Self::spawn(
      shared,
      renderer,
      Target::Offscreen(texture),
      None,
    ))
  }

  /// A presenter in a window of its own on display `display`. UI thread only.
  pub fn window(shared: Arc<Shared>, display: i32, fullscreen: bool) -> Result<Self, Error> {
    let device = MTLCreateSystemDefaultDevice().ok_or(Error::NoDevice)?;
    let renderer = Renderer::new(device)?;
    let window = Window::open(&renderer.device, display, fullscreen)?;
    let layer = window.layer();
    Ok(Self::spawn(
      shared,
      renderer,
      Target::Layer(layer),
      Some(window),
    ))
  }

  fn spawn(
    shared: Arc<Shared>,
    renderer: Renderer,
    target: Target,
    window: Option<Window>,
  ) -> Self {
    shared.begin_presenting();
    let work = SendBox((renderer, target, shared.clone()));
    let thread = std::thread::Builder::new()
      .name("rtcviewer-present".into())
      .spawn(move || {
        let (renderer, target, shared) = work.into_inner();
        render_loop(&renderer, &target, &shared);
      })
      .ok();
    Self {
      shared,
      thread,
      window,
    }
  }

  pub fn has_window(&self) -> bool {
    self.window.is_some()
  }

  /// Stops drawing and closes the window (on the UI thread when there is one).
  pub fn stop(mut self) {
    self.join();
    if let Some(window) = self.window.take() {
      window.close();
    }
  }

  /// Stops drawing and leaves the window to the process (off the UI thread).
  pub fn abandon(mut self) {
    self.join();
    if let Some(window) = self.window.take() {
      std::mem::forget(window);
    }
  }

  fn join(&mut self) {
    self.shared.end_presenting();
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

fn render_loop(renderer: &Renderer, target: &Target, shared: &Arc<Shared>) {
  loop {
    let frame = match shared.mailbox.take(Duration::from_millis(250)) {
      Err(()) => return,
      Ok(None) => continue,
      Ok(Some(frame)) => frame,
    };
    objc2::rc::autoreleasepool(|_| draw(renderer, target, shared, frame));
  }
}

fn draw(renderer: &Renderer, target: &Target, shared: &Arc<Shared>, frame: Frame) {
  let Some(command) = renderer.queue.commandBuffer() else {
    shared.on_present_dropped();
    return;
  };
  let (push, decoded) = (frame.push_time, frame.decoded_time);
  match target {
    Target::Layer(layer) => {
      size_drawable(layer);
      let Some(drawable) = layer.nextDrawable() else {
        shared.on_present_dropped();
        return;
      };
      let Some(keep) = renderer.encode(&command, &drawable.texture(), &frame) else {
        shared.on_present_dropped();
        return;
      };
      // When the GPU finished this frame (f64 bits): the fallback present time below.
      let gpu_end = Arc::new(AtomicU64::new(0));
      let presented = {
        let shared = shared.clone();
        let gpu_end = gpu_end.clone();
        RcBlock::new(move |d: NonNull<ProtocolObject<dyn MTLDrawable>>| {
          // SAFETY: Metal passes the live drawable.
          let shown = unsafe { d.as_ref() }.presentedTime();
          if shown > 0.0 {
            shared.on_presented(push, decoded, shown);
          } else {
            // No display time: a virtual display (a VM's) reports none, and neither does a
            // drawable the compositor discarded. Counted apart, timed at GPU completion.
            let end = f64::from_bits(gpu_end.load(Ordering::Acquire));
            shared.on_presented_untimed(push, decoded, if end > 0.0 { end } else { now() });
          }
        })
      };
      let drawable: &ProtocolObject<dyn MTLDrawable> = ProtocolObject::from_ref(&*drawable);
      // SAFETY: the block is retained by Metal until it has run.
      unsafe { drawable.addPresentedHandler(RcBlock::as_ptr(&presented)) };
      command.presentDrawable(drawable);
      keep_alive(&command, (frame, keep), Report::GpuEnd(gpu_end));
    }
    Target::Offscreen(texture) => {
      let Some(keep) = renderer.encode(&command, texture, &frame) else {
        shared.on_present_dropped();
        return;
      };
      keep_alive(
        &command,
        (frame, keep),
        Report::Presented(shared.clone(), push, decoded),
      );
    }
  }
  command.commit();
}

/// What a command buffer's completion reports.
enum Report {
  /// The offscreen target: completion is the present.
  Presented(Arc<Shared>, f64, f64),
  /// A window: completion is recorded for the presented handler's fallback.
  GpuEnd(Arc<AtomicU64>),
}

/// Holds the picture and its textures until the GPU is done with them, then reports the
/// completion time.
fn keep_alive(
  command: &ProtocolObject<dyn MTLCommandBuffer>,
  keep: (Frame, (Cf, Cf)),
  report: Report,
) {
  let keep = Cell::new(Some(keep));
  let done = RcBlock::new(move |c: NonNull<ProtocolObject<dyn MTLCommandBuffer>>| {
    drop(keep.take());
    // SAFETY: Metal passes the live command buffer.
    let end = unsafe { c.as_ref() }.GPUEndTime();
    let end = if end > 0.0 { end } else { now() };
    match &report {
      Report::Presented(shared, push, decoded) => shared.on_presented(*push, *decoded, end),
      Report::GpuEnd(slot) => slot.store(end.to_bits(), Ordering::Release),
    }
  });
  // SAFETY: the block is retained by Metal until it has run.
  unsafe { command.addCompletedHandler(RcBlock::as_ptr(&done)) };
}

/// Keeps the layer's drawable size equal to its bounds in pixels (a layer-hosting view doesn't do
/// it for us).
fn size_drawable(layer: &CAMetalLayer) {
  let bounds = layer.bounds();
  let scale = layer.contentsScale();
  let want = objc2_foundation::NSSize {
    width: bounds.size.width * scale,
    height: bounds.size.height * scale,
  };
  if want.width >= 1.0 && want.height >= 1.0 && layer.drawableSize() != want {
    layer.setDrawableSize(want);
  }
}

#[cfg(test)]
mod tests {
  use super::fit;

  #[test]
  fn letterboxes_and_pillarboxes() {
    let v = fit(1920.0, 1080.0, 640.0, 480.0);
    assert_eq!((v.width, v.height), (1440.0, 1080.0));
    assert_eq!((v.originX, v.originY), (240.0, 0.0));
    let v = fit(1000.0, 1000.0, 1920.0, 1080.0);
    assert!((v.width - 1000.0).abs() < 1e-9);
    assert!((v.height - 562.5).abs() < 1e-9);
    assert!((v.originY - 218.75).abs() < 1e-9);
  }
}
