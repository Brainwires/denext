//! A one-slot mailbox between the decoder's output and the presenter: the presenter always takes
//! the NEWEST picture, and a picture the decoder replaces before the presenter got to it is
//! dropped (counted, never queued). A queue would add a frame of latency for every frame it held.

use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// The slot and whether the mailbox is closed.
struct Slot<T> {
  item: Option<T>,
  closed: bool,
}

/// A latest-wins mailbox.
pub struct Mailbox<T> {
  slot: Mutex<Slot<T>>,
  ready: Condvar,
}

impl<T> Default for Mailbox<T> {
  fn default() -> Self {
    Self {
      slot: Mutex::new(Slot {
        item: None,
        closed: false,
      }),
      ready: Condvar::new(),
    }
  }
}

impl<T> Mailbox<T> {
  /// Puts `item` in the slot. Returns whether it replaced one nobody took (a dropped frame). A
  /// closed mailbox drops `item` and returns `true`.
  pub fn put(&self, item: T) -> bool {
    let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
    if slot.closed {
      return true;
    }
    let replaced = slot.item.replace(item).is_some();
    self.ready.notify_one();
    replaced
  }

  /// Waits up to `timeout` for an item. `Err(())` once the mailbox is closed.
  #[allow(clippy::result_unit_err)]
  pub fn take(&self, timeout: Duration) -> Result<Option<T>, ()> {
    let slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
    let (mut slot, _) = self
      .ready
      .wait_timeout_while(slot, timeout, |s| s.item.is_none() && !s.closed)
      .unwrap_or_else(|e| e.into_inner());
    if slot.closed {
      return Err(());
    }
    Ok(slot.item.take())
  }

  /// Closes the mailbox, dropping what it holds, and wakes the taker.
  pub fn close(&self) {
    let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
    slot.closed = true;
    slot.item = None;
    self.ready.notify_all();
  }

  /// Opens a closed mailbox again (empty).
  pub fn reopen(&self) {
    let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
    slot.closed = false;
    slot.item = None;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;

  #[test]
  fn newest_wins() {
    let m = Mailbox::default();
    assert!(!m.put(1));
    assert!(m.put(2)); // 1 was never taken: dropped
    assert_eq!(m.take(Duration::ZERO), Ok(Some(2)));
    assert_eq!(m.take(Duration::ZERO), Ok(None));
  }

  #[test]
  fn close_wakes_the_taker() {
    let m = Arc::new(Mailbox::<u32>::default());
    let taker = {
      let m = m.clone();
      std::thread::spawn(move || m.take(Duration::from_secs(10)))
    };
    std::thread::sleep(Duration::from_millis(20));
    m.close();
    assert_eq!(taker.join().unwrap(), Err(()));
    assert!(m.put(3));
    m.reopen();
    assert!(!m.put(4));
    assert_eq!(m.take(Duration::ZERO), Ok(Some(4)));
  }
}
