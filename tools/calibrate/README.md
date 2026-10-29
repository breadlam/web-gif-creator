# Size-model calibration

The app picks the GIF frame rate by **calculating** the file size rather than by trial
encodes. `calibrate.py` fits the constants that calculation uses and writes
`src/lib/sizeModel.json`.

## The model

Per the GIF89a structure, a GIF is a small fixed header plus one LZW-compressed image per
frame. Size is linear in frame count:

```
bytes ≈ 1024 + frames × (width × height × k + 24)
```

`k`, the bytes per pixel per frame, is the only unknown. It depends on how much of each
frame changes from the previous one. ffmpeg's GIF encoder (`gifflags=offsetting+transdiff`)
and `paletteuse=diff_mode=rectangle` only re-encode the bounding box of changed pixels.
So the model is

```
k = Σ cᵢ · featureᵢ
```

with one or two features per dither mode, from one cheap ffmpeg pass over the clip
(`tblend=all_mode=difference`, then `bbox` or a thresholded `signalstats`). Each feature is
a per-frame mean, with the first frame counting as fully changed:

- `bboxT`: fraction of the frame inside the bounding box of pixels whose luma changed by more than T
- `changedT`: fraction of pixels whose luma changed by more than T

Coefficients are fitted per output height (360/540/720, interpolated in between). The app
budgets for `k × margin`, where the margin is the 90th percentile of actual/predicted.

## Running it

```sh
./build-ffmpeg.sh          # native FFmpeg 5.1.4 with --disable-asm = the ffmpeg.wasm code paths
./calibrate.py --ffmpeg .cache/ffmpeg-5.1.4-install/bin/ffmpeg \
    --source a.mkv --source b.mp4 ...  --out ../../src/lib/sizeModel.json
```

- Each source contributes 8 clips of 6 s. Each clip is encoded at 3 heights × 3 frame rates
  × 4 dither modes, and every feature is measured.
- `--prep-ffmpeg` (default: `ffmpeg` on PATH) decodes sources into lossless scaled clips.
  It needs a decoder for every source codec (FFmpeg 5.1.4 without dav1d can't decode AV1).
- Results are cached in `.cache/work`, so re-running only refits.
- **More, more varied sources make the model better.** Cross-validation holds out one whole
  source at a time, so the scores show how the model does on footage it hasn't seen.

## Current accuracy

The current fit uses 5 sources (40 clips): anime (H.264), 4K live action (AV1), 1080p60
game footage, a 1440p review video (VP9) and a 1080p game trailer. Leave-one-source-out
results for the default sierra2_4a at all heights:

| | |
|---|---|
| Average budget use | 74% |
| Held-out clips over budget | 20% (worst 15% over) |

Per-clip error is large in both directions. Two effects are not captured:

- **Encoder noise in "static" frames.** Changes of 1–2 levels everywhere make paletteuse
  re-dither the whole frame. With error diffusion that scrambles the dither pattern, so
  `bbox3` misses the cost, while `bbox1` sees it but over-charges flat content such as anime.
- **Content complexity.** A changed pixel costs far less in flat anime than in detailed game
  footage. Spatial measures such as `siti` SI or edge density did not help in testing. A
  one-frame encode did (11% over budget instead of 20%), but it is a small trial encode.

The app shows the estimate next to the actual size and offers a one-click re-encode at a
lower rate when a GIF comes out over the limit.
