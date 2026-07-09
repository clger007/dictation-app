// keytap — tiny CGEventTap helper for the Dictation app (macOS only).
//
// Streams keyboard events as JSON lines on stdout so the Electron main process
// can offer press-to-record hotkey capture, bind the Fn/Globe key, and support
// hold-to-talk — none of which Electron's globalShortcut can do.
//
//   {"t":"ready"}                          tap installed
//   {"t":"d","k":<keycode>,"f":<flags>}    key down (autorepeats suppressed)
//   {"t":"u","k":<keycode>,"f":<flags>}    key up
//   {"t":"f","k":<keycode>,"f":<flags>}    modifier flags changed (Fn = k 63)
//
// Uses a default (not listen-only) session tap so the existing Accessibility
// permission covers it; events pass through unmodified. Build:
//   clang -O2 -o assets/keytap scripts/keytap.c \
//     -framework ApplicationServices -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>

static CFMachPortRef tap = NULL;

static CGEventRef callback(CGEventTapProxy proxy, CGEventType type,
                           CGEventRef event, void *refcon) {
  (void)proxy;
  (void)refcon;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (tap) CGEventTapEnable(tap, true);
    return event;
  }
  int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  CGEventFlags flags = CGEventGetFlags(event);
  if (type == kCGEventKeyDown) {
    int64_t rep = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat);
    if (!rep) {
      printf("{\"t\":\"d\",\"k\":%lld,\"f\":%llu}\n", keycode,
             (unsigned long long)flags);
      fflush(stdout);
    }
  } else if (type == kCGEventKeyUp) {
    printf("{\"t\":\"u\",\"k\":%lld,\"f\":%llu}\n", keycode,
           (unsigned long long)flags);
    fflush(stdout);
  } else if (type == kCGEventFlagsChanged) {
    printf("{\"t\":\"f\",\"k\":%lld,\"f\":%llu}\n", keycode,
           (unsigned long long)flags);
    fflush(stdout);
  }
  return event; // pass through untouched
}

int main(void) {
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                     CGEventMaskBit(kCGEventKeyUp) |
                     CGEventMaskBit(kCGEventFlagsChanged);
  tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                         kCGEventTapOptionDefault, mask, callback, NULL);
  if (!tap) {
    // Almost always: the host app is not trusted for Accessibility yet.
    printf("{\"t\":\"denied\"}\n");
    fflush(stdout);
    return 1;
  }
  CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  printf("{\"t\":\"ready\"}\n");
  fflush(stdout);
  CFRunLoopRun();
  return 0;
}
