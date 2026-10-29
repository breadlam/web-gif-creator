# Web GIF Creator: survey and plan

*Survey 2026-10-28; plan revised 2026-10-29 after discussion and testing.*

Goal: a static site (GitHub Pages) that reproduces this ffmpeg workflow in the browser:

```
trim → scale (540p default) → frame rate that fits a size budget (20 MB default)
→ palettegen → paletteuse → GIF, optionally with burned-in subtitles or positioned text
```

## 1. Decisions

| Decision | Why |
|---|---|
| **ffmpeg.wasm is the core**: probing, subtitle extraction, fonts, trim, scale, palette, GIF, burn-in, analysis | It does every media step already. The browser code is only GUI and orchestration. |
| **Single-threaded core** (`@ffmpeg/core` 0.12.10) | GitHub Pages can't send COOP/COEP headers, which the `-mt` core needs. Clips for ~20 MB GIFs are short, so speed is acceptable. |
| **No Rust** | With ffmpeg doing the media work there is nothing for it to do. Revisit only if a real job appears. |
| **Frame rate is calculated**, not found by trial encodes | Size is linear in frame count (§4). One cheap analysis pass measures the clip. |
| **TypeScript + Svelte 5 + Vite** | Small, fast UI. Builds to static files with relative paths. |

## 2. Architecture (as built)

```
Browser main thread (Svelte UI)
 ├─ <video> preview (object URL of the file), or ffmpeg-rendered stills if it can't play
 ├─ Timeline: whole-video + zoomed bars, in/out handles, frame stepping, keyboard shortcuts
 ├─ Text overlays: HTML preview with libass-matched sizing, drag to position
 └─ state.svelte.ts: actions → lib/pipeline.ts → lib/engine.ts
                                                  │  (serialised, one wasm instance)
                                     ffmpeg.wasm worker (FFmpeg 5.1.4, libass, freetype)
                                      /input  WORKERFS mount of the File (no copy)
                                      /fonts  bundled OFL fonts + MKV font attachments
                                      /work   probe JSON, ASS files, analysis metadata, output
```

| Module | Role |
|---|---|
| `src/lib/engine.ts` | ffmpeg.wasm wrapper: serialised ops, WORKERFS input, cancel (terminate) with transparent reload |
| `src/lib/audioPreview.ts` | preview sound via a second ffmpeg instance when the browser can't play the selected audio |
| `src/lib/pipeline.ts` | open/probe, fonts, subtitle extraction, analysis, planning, encode, preview frames |
| `src/lib/commands.ts` | every ffmpeg argument list; the GIF chain must match the calibrator |
| `src/lib/sizeModel.ts` + `sizeModel.json` | the frame-rate calculation (§4) |
| `src/lib/ass.ts`, `fontNames.ts` | ASS generation for captions, cue parsing/toggling, font fallback |
| `tools/calibrate/` | builds native FFmpeg 5.1.4 and fits `sizeModel.json` |
| `tests/unit`, `tests/e2e/smoke.mjs` | vitest unit tests; real-Chromium end-to-end run against the production build |

The ffmpeg graphs (`src/lib/commands.ts`):

```
encode:   -ss S -t D -i IN -filter_complex
          [0:v]scale=w='trunc(H*dar/2)*2':h=H:flags=lanczos,setsar=1,fps=F,
               [setpts=PTS+S/TB,subtitles=…:fontsdir=/fonts,…,setpts=PTS-STARTPTS,]
               split=3[n][a][b];
          [a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=…:diff_mode=rectangle[g]
          -map [n] -f null -   (progress counter)   -map [g] -loop 0 out.gif
analysis: same source chain → format=yuv420p,tblend=all_mode=difference → bbox / signalstats
          → metadata=print:file=…  (no palette, no GIF)
```

Subtitles and captions are both ASS files burned in with `subtitles=`, *before* the `fps`
filter. The subtitles filter truncates frame times to whole milliseconds, and after `fps`
the time base is a whole frame, so a frame at a line's exact start could be skipped. A 1 ms
nudge in the timestamp shift covers the remaining rounding.

- **Captions** are generated with `PlayResX/Y` equal to the GIF size and `\pos()` from the
  dragged position.
- **Embedded text tracks** are all converted in one pass when a file opens
  (`-map 0:N -c:s copy|ass` per track). The default track is the one in the browser's
  language that isn't signs/songs, with the most lines.
- **"Original styling"** burns the track's ASS (lines switched off become `Comment:`;
  edited lines get their text replaced).
- **"My style"** regenerates the lines in the clip with one style. It uses bottom-centre
  alignment plus margins rather than `\pos()`, so lines that overlap in time stack the way
  normal subtitles do.

## 3. Constraints and quirks found along the way

- **GitHub Pages: no custom headers.** That rules out SharedArrayBuffer, so no `-mt` core.
  `coi-serviceworker` is the only workaround (it reloads on first visit); not used.
- **ffmpeg.wasm is FFmpeg n5.1.4** (last release 2025-01-07). The Dockerfile notes it can't
  move to n6.0 because the newer ffmpeg CLI requires threads, which would break the
  single-thread build. Consequences:
  - It lacks the perceptual (OkLab) palettegen rewrite of 2023-01-03 (FFmpeg 6.0+), so GIFs
    won't exactly match a current native ffmpeg (8.1.2 here).
  - **It can't decode AV1.** There is no dav1d, and the native `av1` decoder is
    hardware-only. YouTube downloads are often AV1, so the app detects this and says so.
  - `ffprobe` returns −1 even on success (the core only sets the exit code on ffmpeg's
    exit path), so the app checks for the output file instead.
- **libass has no system fonts** in the wasm build, and renders *nothing* for a font it
  can't find. ffmpeg's SRT→ASS conversion asks for "Arial", for example. The app bundles
  Noto Sans and Anton (OFL), loads MKV font attachments, reads every font's real names from
  its `name` table, and remaps styles or `\fn` overrides that name a missing font to Noto Sans.
- **`metadata=mode=print` skips frames with no value**, e.g. when bbox finds no changed
  pixel (common with animation held "on twos"). Feature means divide by the real frame count.
- `FFmpeg.writeFile` transfers the buffer to the worker, which detaches the caller's copy.
- `-ss` before `-i` resets timestamps to 0, but ASS times are source times. Hence the
  `setpts` shift around `subtitles=`.
- GIF delays are whole centiseconds, and browsers show ≤ 1 cs as 10 cs, so 50 fps is the
  maximum. "Even frame timing" restricts rates to 100/n.

## 4. Frame-rate calculation

From the GIF89a structure: a header (~1 KB with the global palette), then per frame a
graphic control extension, an image descriptor and LZW data. So

```
bytes ≈ 1024 + frames × (width × height × k + 24)        frames = ⌈duration × fps⌉
fps   = largest rate with  bytes(k × margin) ≤ budget,   capped at source fps and 50
```

`k` (bytes per pixel per frame) is the only unknown, and it depends on the content. Only the
bounding box of changed pixels is re-encoded, so `k` is modelled from frame differences that
one ffmpeg pass measures: `tblend=all_mode=difference` → `bbox` (box area) or a thresholded
changed-pixel fraction. Coefficients and the safety margin come from `tools/calibrate`
(1,440 encodes, FFmpeg 5.1.4, 5 sources × 8 clips × 3 heights × 3 frame rates × 4 dither
modes). Details are in `tools/calibrate/README.md`.

**Accuracy, honestly:** size is reliably linear in frame count, and `k` barely moves with
frame rate. But per-clip `k` varies with content in ways frame differences don't fully
capture. Leave-one-source-out cross-validation (default dither):

| | |
|---|---|
| Average budget use | 74% |
| Held-out clips over budget | 20% (worst 15% over) |

The two failure modes:

- **Noise.** Encoder noise of 1–2 levels re-dithers the whole frame under error diffusion.
- **Complexity.** A changed pixel costs less in flat content than in detailed content.

End-to-end examples:
- A 4 s anime clip was predicted at 14.4 MB and came out at 5.2 MB: safe, but under-used.
- Before the frame-count fix, the same clip was under-predicted 6.8×.

The UI shows the estimate next to the actual size, plus a one-click re-encode at a lower
rate when a GIF exceeds the limit.

**Open choice:** keep the pure calculation and accept a correction step about 1 time in 5,
or allow a one-frame encode as a complexity measurement. That cut the over-budget rate from
20% to 11% in testing, but it is a (tiny) trial encode.

## 5. Status

Working (verified end-to-end in Chromium with the real ffmpeg.wasm):

- open MP4/MKV/WebM, probe, AV1 detection
- free-form values everywhere, with presets as shortcuts:
  - linked width/height fields (any even size; notes for upscaling and outside the
    calibrated 360–720p range)
  - max size, a fixed frame rate (decimals; mixed delays when even timing is off), and every
    paletteuse dithering mode including `bayer_scale`
  - caption/subtitle size and outline, and playback speed
  - fonts: bundled, embedded in the video, or user-added files (family, weight and libass
    size metrics read from the file)
- trim UI with frame stepping and shortcuts
- size budget, height and dither settings; calculated or fixed frame rate with even-timing option
- track selection for video, audio (for listening) and subtitles; every ffmpeg command
  targets the selected video stream explicitly
- sound while trimming: the browser's own when it can play the selected track, otherwise a
  second ffmpeg.wasm instance decodes about 60 s around the playhead to MP3, kept in sync
  (so it never waits behind analysis or encoding); a silent-playback check switches over
  automatically; volume, mute, speed
- subtitles read on open (ASS and SRT tested), automatic dialogue-track choice, lines on the
  preview, search with Clip/Extend, original styling (embedded fonts) or a draggable custom
  style, per-line toggles and edits
- draggable captions with libass-consistent preview, plus "preview exact frame" rendered through ffmpeg
- GIF encode with progress and cancel; download

Next steps, roughly in priority order:

1. Decide the size-model question above; add more varied calibration sources either way.
2. **AV1:** a custom ffmpeg.wasm build with dav1d (the repo's Dockerfile is the starting
   point). Alternatively decode with WebCodecs and pipe frames to ffmpeg.
3. **Newer palettegen:** backport FFmpeg 6+ `vf_palettegen.c`/`vf_paletteuse.c` into the
   5.1.4 build (they're largely self-contained), or build FFmpeg 7/8 multi-threaded with
   `coi-serviceworker`.
4. **Image subtitles (PGS/VobSub):** `[0:v][0:s:N]overlay` (sub2video) in the same graph.
5. **Live subtitle preview:** JASSUB (libass in wasm) to render ASS over the `<video>`.
   Today the exact preview is the ffmpeg-rendered frame.
6. Optional: gifsicle `--lossy` squeeze when slightly over budget; per-scene palettes.

## 6. Survey reference (what was considered)

| Project | License | Status |
|---|---|---|
| ffmpeg.wasm `@ffmpeg/ffmpeg` 0.12.15 / `@ffmpeg/core` 0.12.10 | MIT / GPL-2.0+ | **Used** (core of the app) |
| Noto Sans, Anton | OFL-1.1 | **Used** (bundled caption/fallback fonts) |
| lyonbot/video-to-gif | Apache-2.0 | Reference: GitHub Pages + ffmpeg.wasm deployment pattern |
| Gifcurry | BSD-3 | Reference: caption model (text, font, colour, outline, position, timing) |
| gifcap (libimagequant + gifsicle in wasm) | MIT / GPL | Reference for a future high-quality encoder option |
| JASSUB (libass in wasm, `manualRender`) | LGPL-2.1+ | Deferred: live ASS preview |
| Mediabunny (WebCodecs demux/decode) | MPL-2.0 | Deferred: possible AV1/HEVC decode fallback. Can't read subtitle tracks |
| web-demuxer, matroska-subtitles, mp4box.js | MIT / MIT / BSD-3 | Not needed: ffmpeg extracts subtitles |
| gifski / gifski-wasm | AGPL-3.0 | Not used: license, and it bypasses the ffmpeg palette pipeline |
| quantette, `gif` crate, fast_image_resize (Rust) | MIT/Apache | Not used: no Rust (see §1) |
| gifsicle (`--lossy`) via wasm | GPL-2.0 | Deferred: over-budget squeeze |
| coi-serviceworker | MIT | Deferred: only needed for the `-mt` core |
| Moveable, wavesurfer.js | MIT / BSD-3 | Not needed yet (custom drag and timeline are enough) |
