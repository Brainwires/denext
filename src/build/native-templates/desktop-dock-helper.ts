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
// The app launches it through LaunchServices with DENEXT_DOCK_HELPER=1 and writes a session file
// beside its bundle (the app's 0700 dock-helper folder, the file 0600): {"port", "token", "pid"}.
// The helper connects to 127.0.0.1:<port>, proves itself with the token, then speaks
// newline-delimited JSON:
//   out  {"t":"hello","token":"..."}  first line
//   out  {"t":"activate"}  the user activated it: bring the app's window to the front
//   out  {"t":"quit"}      the user chose Quit (the Dock menu, Cmd-Q): quit the app
//   in   {"t":"exit"}      leave now (the app's last window closed); the connection closing (the app
//                          quit or crashed) does the same
// Launched otherwise (Spotlight, a tile the user kept in the Dock), or when the app cannot be
// reached, it opens the app it belongs to (Info.plist DenextDockHelperFor) and exits, never showing
// a tile of its own.
#import <Cocoa/Cocoa.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int sock = -1;

static void notify(const char *type) {
  char line[64];
  int n = snprintf(line, sizeof line, "{\\"t\\":\\"%s\\"}\\n", type);
  // The app is gone: nothing left to stand in for.
  if (write(sock, line, (size_t)n) < 0) _exit(0);
}

// Connect to the app named by the session file beside this bundle; its pid, or 0.
static pid_t connectToApp(void) {
  NSString *folder = [[[NSBundle mainBundle] bundlePath] stringByDeletingLastPathComponent];
  NSData *data = [NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:@"session"]];
  if (data == nil) return 0;
  NSDictionary *session = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![session isKindOfClass:[NSDictionary class]]) return 0;
  NSNumber *port = session[@"port"];
  NSString *token = session[@"token"];
  NSNumber *pid = session[@"pid"];
  if (![port isKindOfClass:[NSNumber class]] || ![token isKindOfClass:[NSString class]] ||
      ![pid isKindOfClass:[NSNumber class]]) {
    return 0;
  }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port.unsignedIntValue);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    close(fd);
    return 0;
  }
  sock = fd;
  NSString *hello = [NSString stringWithFormat:@"{\\"t\\":\\"hello\\",\\"token\\":\\"%@\\"}\\n", token];
  const char *bytes = hello.UTF8String;
  if (write(sock, bytes, strlen(bytes)) < 0) {
    close(fd);
    sock = -1;
    return 0;
  }
  return (pid_t)pid.intValue;
}

@interface DockHelper : NSObject <NSApplicationDelegate>
@property pid_t appPid;
@property BOOL managed;
@property BOOL leaving;
@property BOOL poweringOff;
// The app in front before this one launched, and whether the launch is still settling: an
// activation AppKit gives a launching app goes back to where it came from.
@property NSRunningApplication *launchFront;
@property BOOL launching;
@end

@implementation DockHelper

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
  self.launchFront = [[NSWorkspace sharedWorkspace] frontmostApplication];
  self.launching = YES;
  [NSApp setActivationPolicy:self.managed ? NSApplicationActivationPolicyRegular
                                          : NSApplicationActivationPolicyProhibited];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  if (!self.managed) {
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
}

- (void)readCommands {
  FILE *in = fdopen(dup(sock), "r");
  char buf[512];
  while (in != NULL && fgets(buf, sizeof buf, in) != NULL) {
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
// An activation AppKit gives the launching helper goes back to the app that was in front instead.
- (void)handBack {
  if (!self.managed) return;
  NSRunningApplication *front = self.launchFront;
  if (self.launching && front != nil && front.processIdentifier != getpid()) {
    giveActivation(front);
    return;
  }
  NSRunningApplication *app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:self.appPid];
  if (app != nil) giveActivation(app);
  notify("activate");
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  // A logout / restart / shutdown asks with a reason (kAEQuitReason, 'why?'): never hold it up.
  // The Dock's Quit and Cmd-Q carry none.
  NSAppleEventDescriptor *event = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
  BOOL sessionEnd = [event paramDescriptorForKeyword:'why?'] != nil;
  if (self.leaving || self.poweringOff || !self.managed || sessionEnd) return NSTerminateNow;
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
    DockHelper *delegate = [DockHelper new];
    const char *flag = getenv("DENEXT_DOCK_HELPER");
    if (flag != NULL && strcmp(flag, "1") == 0) {
      delegate.appPid = connectToApp();
      delegate.managed = delegate.appPid > 0;
    }
    NSApplication *app = [NSApplication sharedApplication];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
`,
};
