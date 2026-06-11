{
  "targets": [
    {
      "target_name": "screen_prompt",
      "sources": ["native/screen-prompt.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-fobjc-arc"],
        "MACOSX_DEPLOYMENT_TARGET": "13.0"
      },
      "link_settings": {
        "libraries": ["-framework ScreenCaptureKit", "-framework Foundation"]
      }
    }
  ]
}
