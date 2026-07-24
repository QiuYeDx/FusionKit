{
  "targets": [
    {
      "target_name": "local_subtitle_overwrite",
      "sources": [
        "src/addon.cc"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources!": [
              "src/addon.cc"
            ],
            "sources": [
              "src/addon-win32.cc"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++17"
                ]
              }
            }
          }
        ]
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions"
      ],
      "xcode_settings": {
        "ARCHS": [
          "arm64"
        ],
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      }
    }
  ]
}
