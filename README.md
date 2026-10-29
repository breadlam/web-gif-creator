# Web GIF Creator

Turn video clips into high-quality GIFs in the browser, sized to fit a file-size budget.
Everything runs locally with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm); the
video is never uploaded. Deploys as a static site to GitHub Pages.

- Trim with a timeline, frame stepping and keyboard shortcuts, with sound (volume, mute,
  0.5×–1.25× speed). If the browser can't play the file's audio (AC-3/DTS, a second audio
  track, files it can't play at all), ffmpeg decodes the sound instead.
- Choose which video, audio and subtitle track to work with.
- Set a max file size (default 20 MB) and height (default 540p). The frame rate is
  *calculated* from one quick analysis pass, not found by trial encodes.
- ffmpeg's `palettegen` → `paletteuse` pipeline, with a choice of dithering.
- Subtitles are read from the video when it opens (ASS/SSA/SRT/WebVTT, with embedded
  fonts). The dialogue track is picked automatically, and lines show on the preview. Search
  lines and press **Clip** to set the range to a line. Burn them in with the original
  styling, or in your own font, size and colours, dragged into place. Each line can be
  switched off or edited.
- Add your own captions and drag them into place. "Preview exact frame" renders through ffmpeg.

See [docs/survey.md](docs/survey.md) for the design, constraints and roadmap, and
[tools/calibrate/README.md](tools/calibrate/README.md) for how the size model is fitted
and how accurate it is.

## Development

Requires Node 24.

```sh
npm ci
npm run dev        # copies the ffmpeg core into public/ and starts Vite
npm run check      # svelte-check (types)
npm test           # unit tests
npm run build      # static site in dist/
npm run e2e        # end-to-end in Chromium against dist/ (see below)
```

`npm run e2e -- --video some.mkv` drives a real Chromium through open → trim → subtitles →
caption → preview → encode and checks the GIF against the budget. With no `--video` it
generates a synthetic clip (needs `ffmpeg` on PATH). It uses Playwright's Chromium from
`~/.cache/ms-playwright`, or `--chromium <path>` / `CHROMIUM_PATH`.

## Deployment

Push to `main`. `.github/workflows/deploy.yml` type-checks, tests, builds and publishes to
GitHub Pages. In the repository settings, set **Pages → Source** to **GitHub Actions**. The
build uses relative paths, so it works under `https://<user>.github.io/<repo>/`.

## Limits

- **AV1 video can't be decoded** by the ffmpeg.wasm build (FFmpeg 5.1.4 without dav1d).
- Single-threaded ffmpeg: fine for short clips, slow for long or 4K HEVC sources.
- Image-based subtitles (PGS, VobSub) aren't supported yet.
- Size estimates vary with content; see the calibration README. If a GIF comes out over
  the limit, the app offers a re-encode at a lower frame rate.

## Licenses

App code: not yet chosen. Bundled: ffmpeg.wasm core (GPL-2.0-or-later, includes x264 and
libass), Noto Sans and Anton (SIL OFL 1.1, see `public/fonts/`).
