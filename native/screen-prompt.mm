// Triggers the macOS Screen Recording authorization flow via ScreenCaptureKit.
//
// On macOS 15+ the legacy CGRequestScreenCaptureAccess() is a no-op and
// Chromium's capture preflight never reaches ScreenCaptureKit, so the app
// would neither prompt nor appear in System Settings. Enumerating shareable
// content does both - but ONLY when called in-process from the app bundle:
// macOS 26 refuses to prompt for plain-executable child processes (tccd:
// "Service kTCCServiceScreenCapture does not allow prompting") and hides
// their Settings entries. Hence this N-API addon instead of a spawned helper.

#include <napi.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>

Napi::Value TriggerScreenCapturePrompt(const Napi::CallbackInfo& info) {
  if (@available(macOS 12.3, *)) {
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                                onScreenWindowsOnly:YES
                                                  completionHandler:^(SCShareableContent *content, NSError *error) {
      // Fire-and-forget: granted/denied state reaches the renderer via its
      // permissions poll; the enumeration result itself is irrelevant here.
      (void)content; (void)error;
    }];
  }
  return info.Env().Undefined();
}

// windowBounds(cgWindowId) -> { x, y, width, height } in screen points (origin
// top left, the same coordinates Electron's `screen` uses), or null when the
// window is gone. Bounds are public window-server data: no permission needed.
Napi::Value WindowBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Null();
  CGWindowID windowId = info[0].As<Napi::Number>().Uint32Value();
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId);
  if (!list) return env.Null();
  Napi::Value result = env.Null();
  if (CFArrayGetCount(list) > 0) {
    CFDictionaryRef entry = (CFDictionaryRef)CFArrayGetValueAtIndex(list, 0);
    CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(entry, kCGWindowBounds);
    CGRect rect;
    if (boundsRef && CGRectMakeWithDictionaryRepresentation(boundsRef, &rect)) {
      Napi::Object bounds = Napi::Object::New(env);
      bounds.Set("x", Napi::Number::New(env, rect.origin.x));
      bounds.Set("y", Napi::Number::New(env, rect.origin.y));
      bounds.Set("width", Napi::Number::New(env, rect.size.width));
      bounds.Set("height", Napi::Number::New(env, rect.size.height));
      result = bounds;
    }
  }
  CFRelease(list);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("triggerScreenCapturePrompt",
              Napi::Function::New(env, TriggerScreenCapturePrompt));
  exports.Set("windowBounds", Napi::Function::New(env, WindowBounds));
  return exports;
}

NODE_API_MODULE(screen_prompt, Init)
