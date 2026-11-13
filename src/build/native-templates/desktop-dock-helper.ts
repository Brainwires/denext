// The readable source of the macOS Dock helper that `desktop.app.dock: "while-window-open"` builds
// into a packaged app (src/build/desktop-dock-helper.ts compiles it with clang while packaging).
// NOT published: `deno task gen:native-templates` (scripts/gen-native-templates.ts) packs every
// exported record below into src/build/native-templates.packed.ts (Brotli + base64), which the
// published module reads. Edit the source here, then regenerate; tests/native-templates-packed.test.ts
// fails while the packed copy differs.

/** The helper's Objective-C source, by file name. */
export const DESKTOP_DOCK_HELPER_FILES: Readonly<Record<string, string>> = {
  "DockHelper.m":
    `// denext's macOS Dock helper: a regular app with no window of its own, run by a tray app
// (accessory, never regular) while that app has a window open. It holds the app's Dock tile and
// Cmd-Tab entry; activating it (a Dock click, Cmd-Tab) hands the activation back to the tray app.
// It lives outside /Applications, so the Dock adds no recent-apps tile when it quits.
//
// Protocol: newline-delimited JSON over its stdin / stdout pipes (the tray app is its parent).
//   out  {"t":"ready"}     launched
//   out  {"t":"activate"}  the user activated it: bring the app's window to the front
//   out  {"t":"quit"}      the user chose Quit (the Dock menu, Cmd-Q): quit the app
//   in   {"t":"exit"}      leave now (the app's last window closed); EOF on stdin does the same
// Launched without DENEXT_DOCK_HELPER=1 (from Spotlight, a pinned tile), it opens the app it
// belongs to (Info.plist DenextDockHelperFor) and exits, never showing a tile of its own.
#import <Cocoa/Cocoa.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static BOOL managed = NO;

static void notify(const char *type) {
  char line[64];
  int n = snprintf(line, sizeof line, "{\\"t\\":\\"%s\\"}\\n", type);
  // The app is gone: nothing left to stand in for.
  if (write(STDOUT_FILENO, line, (size_t)n) < 0) _exit(0);
}

@interface DockHelper : NSObject <NSApplicationDelegate>
@property pid_t parentPid;
@property BOOL leaving;
@property BOOL poweringOff;
// The app in front before this one launched, and whether the launch is still settling: AppKit
// activates a regular app as it launches, and that activation goes back to where it came from.
@property NSRunningApplication *launchFront;
@property BOOL launching;
@end

@implementation DockHelper

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
  self.launchFront = [[NSWorkspace sharedWorkspace] frontmostApplication];
  self.launching = YES;
  [NSApp setActivationPolicy:managed ? NSApplicationActivationPolicyRegular
                                     : NSApplicationActivationPolicyProhibited];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  if (!managed) {
    [self openOwner];
    return;
  }
  NSString *name = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleName"]
                       ?: [[NSProcessInfo processInfo] processName];
  NSMenu *main = [NSMenu new];
  NSMenuItem *item = [NSMenuItem new];
  [main addItem:item];
  NSMenu *menu = [[NSMenu alloc] initWithTitle:name];
  [menu addItemWithTitle:[@"Quit " stringByAppendingString:name]
                  action:@selector(terminate:)
           keyEquivalent:@"q"];
  item.submenu = menu;
  NSApp.mainMenu = main;
  [[[NSWorkspace sharedWorkspace] notificationCenter]
      addObserver:self
         selector:@selector(willPowerOff:)
             name:NSWorkspaceWillPowerOffNotification
           object:nil];
  [NSThread detachNewThreadSelector:@selector(readCommands) toTarget:self withObject:nil];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    self.launching = NO;
  });
  notify("ready");
}

- (void)readCommands {
  char buf[512];
  while (fgets(buf, sizeof buf, stdin) != NULL) {
    if (strstr(buf, "\\"exit\\"") != NULL) break;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    self.leaving = YES;
    [NSApp terminate:nil];
  });
}

- (void)willPowerOff:(NSNotification *)notification {
  self.poweringOff = YES;
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  [self handBack];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
  [self handBack];
  return NO;
}

// Give the activation to target.
static void giveActivation(NSRunningApplication *target) {
  if (@available(macOS 14.0, *)) {
    [NSApp yieldActivationToApplication:target];
    [target activateFromApplication:[NSRunningApplication currentApplication]
                            options:NSApplicationActivateAllWindows];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [target activateWithOptions:NSApplicationActivateAllWindows |
                                NSApplicationActivateIgnoringOtherApps];
#pragma clang diagnostic pop
  }
}

// The user activated the helper: give the activation to the tray app, which brings its window up.
// The activation AppKit gives a launching app goes back to the app that was in front instead.
- (void)handBack {
  if (!managed) return;
  NSRunningApplication *front = self.launchFront;
  if (self.launching && front != nil && front.processIdentifier != getpid()) {
    giveActivation(front);
    return;
  }
  NSRunningApplication *parent =
      [NSRunningApplication runningApplicationWithProcessIdentifier:self.parentPid];
  if (parent != nil) giveActivation(parent);
  notify("activate");
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  // A logout / restart / shutdown asks with a reason (kAEQuitReason, 'why?'): never hold it up.
  // The Dock's Quit and Cmd-Q carry none.
  NSAppleEventDescriptor *event = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
  BOOL sessionEnd = [event paramDescriptorForKeyword:'why?'] != nil;
  if (self.leaving || self.poweringOff || !managed || sessionEnd) return NSTerminateNow;
  notify("quit");
  return NSTerminateCancel;
}

- (void)openOwner {
  NSString *owner = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"DenextDockHelperFor"];
  NSURL *url = owner ? [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:owner]
                     : nil;
  if (url == nil) {
    [NSApp terminate:nil];
    return;
  }
  NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
  config.activates = YES;
  [[NSWorkspace sharedWorkspace]
      openApplicationAtURL:url
             configuration:config
         completionHandler:^(NSRunningApplication *_app, NSError *_error) {
           dispatch_async(dispatch_get_main_queue(), ^{
             [NSApp terminate:nil];
           });
         }];
}

@end

int main(void) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    const char *flag = getenv("DENEXT_DOCK_HELPER");
    managed = flag != NULL && strcmp(flag, "1") == 0;
    DockHelper *delegate = [DockHelper new];
    delegate.parentPid = getppid();
    NSApplication *app = [NSApplication sharedApplication];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
`,
};
