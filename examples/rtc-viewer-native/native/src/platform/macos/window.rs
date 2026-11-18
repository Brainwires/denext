//! The viewer's own native window, holding the `CAMetalLayer` the render thread draws into.
//!
//! Full-screen is a borderless window covering the whole display above the menu bar and Dock
//! (games' "borderless full-screen"), not AppKit's full-screen Space: no Space switch or
//! animation, the window appears at once, and an opaque layer covering a display is what lets the
//! WindowServer scan it out directly (no composition pass). The window is ordered front without
//! activating the app, so it takes no keyboard focus from what the user is typing in.

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
  NSBackingStoreType, NSColor, NSMainMenuWindowLevel, NSScreen, NSView, NSWindow,
  NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_metal::{MTLDevice, MTLPixelFormat};
use objc2_quartz_core::{CAAutoresizingMask, CAMetalLayer};

use crate::viewer::Error;

/// The window and its layer. Lives on (and is closed from) the UI thread.
pub struct Window {
  window: Retained<NSWindow>,
  layer: Retained<CAMetalLayer>,
}

impl Window {
  /// Opens the window on display `display` (an index into `NSScreen.screens`; the first is the
  /// one with the menu bar).
  pub fn open(
    device: &ProtocolObject<dyn MTLDevice>,
    display: i32,
    fullscreen: bool,
  ) -> Result<Self, Error> {
    let mtm = MainThreadMarker::new().ok_or(Error::NotMainThread)?;
    let screens = NSScreen::screens(mtm);
    let index = usize::try_from(display.max(0)).unwrap_or(0);
    if index >= screens.count() {
      return Err(Error::NoDevice);
    }
    let screen = screens.objectAtIndex(index);
    let area = screen.frame();
    let (rect, style) = if fullscreen {
      (area, NSWindowStyleMask::Borderless)
    } else {
      let size = NSSize {
        width: 1280.0_f64.min(area.size.width),
        height: 720.0_f64.min(area.size.height),
      };
      let origin = NSPoint {
        x: area.origin.x + (area.size.width - size.width) / 2.0,
        y: area.origin.y + (area.size.height - size.height) / 2.0,
      };
      (
        NSRect { origin, size },
        NSWindowStyleMask::Titled
          | NSWindowStyleMask::Closable
          | NSWindowStyleMask::Miniaturizable
          | NSWindowStyleMask::Resizable,
      )
    };
    // SAFETY: on the main thread; the window is not released on close (we own it).
    let window = unsafe {
      let window = NSWindow::initWithContentRect_styleMask_backing_defer(
        NSWindow::alloc(mtm),
        rect,
        style,
        NSBackingStoreType::Buffered,
        false,
      );
      window.setReleasedWhenClosed(false);
      window
    };
    window.setTitle(&NSString::from_str("rtc-viewer-native"));
    window.setOpaque(true);
    window.setBackgroundColor(Some(&NSColor::blackColor()));
    if fullscreen {
      window.setLevel(NSMainMenuWindowLevel + 1);
      window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
          | NSWindowCollectionBehavior::FullScreenAuxiliary,
      );
      window.setHidesOnDeactivate(false);
    }

    let layer = CAMetalLayer::new();
    layer.setDevice(Some(device));
    layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
    layer.setFramebufferOnly(true);
    // Two drawables (one on screen, one being drawn) and no wait for vsync: the lowest latency a
    // swap chain allows.
    layer.setMaximumDrawableCount(2);
    layer.setDisplaySyncEnabled(false);
    layer.setOpaque(true);
    layer.setContentsScale(screen.backingScaleFactor());
    layer.setAutoresizingMask(
      CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
    );

    let content = NSRect {
      origin: NSPoint { x: 0.0, y: 0.0 },
      size: rect.size,
    };
    let view = NSView::initWithFrame(NSView::alloc(mtm), content);
    // A layer-hosting view: the layer first, then wantsLayer.
    view.setLayer(Some(&layer));
    view.setWantsLayer(true);
    window.setContentView(Some(&view));
    // Shown without activating the app or taking key focus.
    window.orderFrontRegardless();
    Ok(Self { window, layer })
  }

  /// The layer, for the render thread.
  pub fn layer(&self) -> Retained<CAMetalLayer> {
    self.layer.clone()
  }

  /// Closes the window. UI thread only.
  pub fn close(self) {
    self.window.orderOut(None);
    self.window.close();
  }
}
