# Preview decoders

`public/decoders/decoder.{mjs,wasm}` is FFmpeg's decoders compiled to WebAssembly, behind a
thin C API (`decoder.c`). The preview uses it for anything the browser's own decoders
(WebCodecs) can't handle, so playback works the same in any browser on any OS. Examples:
10-bit H.264/HEVC in Firefox, or AC-3/E-AC-3/DTS audio. GIF encoding still uses ffmpeg.wasm.

The output is committed, so GitHub Pages and CI don't need this toolchain. Rebuild after
changing `decoder.c` or the decoder list:

```sh
./build-docker.sh     # pinned emscripten/emsdk image; ~1–2 minutes on a large machine
```

| | |
|---|---|
| FFmpeg | 8.1.3 (tarball SHA-256 pinned in `build-docker.sh`) |
| Video decoders | H.264, HEVC (8/10-bit), VP8, VP9, MPEG-1/2/4, Theora, MJPEG |
| Audio decoders | AAC, MP3, MP2, FLAC, Opus, Vorbis, AC-3, E-AC-3, DTS, TrueHD, MLP, ALAC, PCM |
| Flags | `-O3 -msimd128` (FFmpeg's WebAssembly SIMD code included); no threads (GitHub Pages can't enable SharedArrayBuffer) |
| Licence | FFmpeg is LGPL-2.1+; this build enables no GPL components |

How it fits together:

1. **Mediabunny** demuxes the file in JavaScript.
2. For each track, `src/lib/decode/soft.ts` asks WebCodecs (`isConfigSupported`) whether the
   browser can decode it. If not, and this build has the codec, the track is decoded by
   `SoftVideoDecoder`/`SoftAudioDecoder`. These are Mediabunny custom decoders that forward
   packets to `src/lib/decode/worker.ts`, which runs this module off the main thread.
3. Video frames come back as 8-bit I420 (10-bit and other formats are converted with
   swscale) and audio as planar float.

Measured on a 720p 10-bit H.264 episode, software decoding ran at about 2–3× real time,
in Chromium and Firefox 157.
