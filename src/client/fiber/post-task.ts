// One MessageChannel task queue, shared by the time-slicing continuation and the passive-effect
// flush: React's Scheduler posts its work the same way (a setTimeout is clamped, and starves
// behind input tasks and a busy loop). The channel is created on first use and closed once its
// queue drains: an open port with a listener is a ref'd handle that would keep Deno's event loop
// (a CLI, SSR, a test) alive. Where MessageChannel is missing, the task is a setTimeout.

const queue: Array<() => void> = [];
let channel: MessageChannel | undefined;

/** Run `task` on its own macrotask, after every task posted before it. */
export function postTask(task: () => void): void {
  if (typeof MessageChannel === "undefined") {
    setTimeout(task, 0);
    return;
  }
  queue.push(task);
  if (!channel) {
    const c = channel = new MessageChannel();
    c.port1.onmessage = () => {
      try {
        queue.shift()!();
      } finally {
        if (!queue.length) c.port1.close(), c.port2.close(), channel = undefined;
      }
    };
  }
  channel.port2.postMessage(0);
}
