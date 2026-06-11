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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("triggerScreenCapturePrompt",
              Napi::Function::New(env, TriggerScreenCapturePrompt));
  return exports;
}

NODE_API_MODULE(screen_prompt, Init)
