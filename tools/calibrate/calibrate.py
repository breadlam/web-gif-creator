#!/usr/bin/env python3
"""Fit the GIF size model used by the app (src/lib/sizeModel.json).

Model: bytes per pixel per frame  k = sum(c_i * f_i), with one or two features f_i per
dither mode, each a per-frame mean over the clip (first frame counts as fully changed):
  bboxT    - fraction of the frame inside the bounding box of pixels whose luma changed
             by more than T since the previous frame (tblend difference + bbox)
  changedT - fraction of pixels whose luma changed by more than T
Coefficients are fitted per output height. The app multiplies predictions by the
model's margin, the worst actual/predicted ratio seen on the calibration clips.

The encode chain here must stay identical to src/lib/commands.ts.

Example:
  ./build-ffmpeg.sh
  ./calibrate.py --ffmpeg .cache/ffmpeg-5.1.4-install/bin/ffmpeg \
      --source ~/a.mkv --source ~/b.mp4 --out ../../src/lib/sizeModel.json
"""
import argparse
import concurrent.futures as cf
import itertools
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Every paletteuse dithering mode in FFmpeg 5.1.4. Bayer is calibrated per bayer_scale,
# since the pattern strength changes how well frames compress.
DITHERS = {
    "sierra2_4a": "dither=sierra2_4a",
    "sierra2": "dither=sierra2",
    "floyd_steinberg": "dither=floyd_steinberg",
    "heckbert": "dither=heckbert",
    **{f"bayer{n}": f"dither=bayer:bayer_scale={n}" for n in range(6)},
    "none": "dither=none",
}
FEATURES = [("bbox", 0), ("bbox", 1), ("bbox", 3), ("bbox", 8), ("changed", 1), ("changed", 3)]
MARGIN_PERCENTILE = 0.90
MAX_OVERSHOOT = 0.10


def percentile(values, p):
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, cmd))}\n{r.stderr[-2000:]}")
    return r


def probe_duration(ffprobe, src):
    out = run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).stdout
    return float(out.strip())


def scale_filter(height):
    # Same expression as the app: display-aspect-correct width, rounded to even.
    return f"scale=w='trunc({height}*dar/2)*2':h={height}:flags=lanczos,setsar=1"


def make_clip(prep_ffmpeg, src, start, dur, height, out):
    if out.exists():
        return
    tmp = out.with_suffix(".part.mkv")
    run([prep_ffmpeg, "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", str(dur), "-i", src,
         "-an", "-sn", "-dn", "-vf", scale_filter(height), "-c:v", "ffv1", str(tmp)])
    tmp.rename(out)


def gif_dims_and_frames(path):
    data = path.read_bytes()
    w = int.from_bytes(data[6:8], "little")
    h = int.from_bytes(data[8:10], "little")
    # Walk the block structure to count image descriptors.
    i = 13
    if data[10] & 0x80:
        i += 3 * (2 << (data[10] & 7))
    frames = 0
    while i < len(data):
        b = data[i]
        if b == 0x3B:
            break
        if b == 0x21:  # extension: label, then sub-blocks
            i += 2
            while data[i]:
                i += data[i] + 1
            i += 1
        elif b == 0x2C:  # image descriptor
            frames += 1
            flags = data[i + 9]
            i += 10
            if flags & 0x80:
                i += 3 * (2 << (flags & 7))
            i += 1  # LZW minimum code size
            while data[i]:
                i += data[i] + 1
            i += 1
        else:
            raise ValueError(f"bad GIF block 0x{b:02x} in {path}")
    return w, h, frames


def encode(ffmpeg, clip, fps, dither, out):
    if not out.exists():
        graph = (f"fps={fps},split[a][b];[a]palettegen=stats_mode=diff[p];"
                 f"[b][p]paletteuse={DITHERS[dither]}:diff_mode=rectangle")
        run([ffmpeg, "-v", "error", "-y", "-i", str(clip), "-filter_complex", graph,
             "-loop", "0", str(out)])
    w, h, n = gif_dims_and_frames(out)
    return out.stat().st_size / (w * h * n), w, h, n


def parse_metadata(text, key):
    """Return a list (one entry per frame) of the value of `key`, or None if absent."""
    frames, cur, started = [], None, False
    for line in text.splitlines():
        if line.startswith("frame:"):
            if started:
                frames.append(cur)
            cur, started = None, True
        elif line.startswith(key + "="):
            cur = float(line.split("=", 1)[1])
    if started:
        frames.append(cur)
    return frames


def feature_sum(ffmpeg, clip, fps, kind, thr, cache):
    """Sum over frames of the changed fraction. metadata=print skips frames that carry no
    value (e.g. bbox found no changed pixel), so the caller divides by the real frame count."""
    if cache.exists():
        return float(cache.read_text())
    meta = cache.with_suffix(".txt")
    base = f"fps={fps},format=yuv420p,tblend=all_mode=difference"
    if kind == "bbox":
        vf = f"{base},bbox=min_val={thr},metadata=mode=print:file={meta}"
    else:
        vf = (f"{base},lutyuv=y='if(gt(val,{thr}),255,0)',signalstats,"
              f"metadata=mode=print:key=lavfi.signalstats.YAVG:file={meta}")
    run([ffmpeg, "-v", "error", "-nostats", "-i", str(clip), "-vf", vf, "-f", "null", "-"])
    text = meta.read_text() if meta.exists() else ""
    w, h = probe_dims(ffmpeg, clip)
    if kind == "bbox":
        ws = parse_metadata(text, "lavfi.bbox.w")
        hs = parse_metadata(text, "lavfi.bbox.h")
        areas = [(a or 0) * (b or 0) / (w * h) for a, b in zip(ws, hs)]
    else:
        areas = [(v or 0) / 255 for v in parse_metadata(text, "lavfi.signalstats.YAVG")]
    value = sum(areas)
    cache.write_text(repr(value))
    return value


_dims = {}


def probe_dims(ffmpeg, clip):
    if clip not in _dims:
        ffprobe = Path(ffmpeg).with_name("ffprobe")
        out = run([str(ffprobe), "-v", "error", "-select_streams", "v:0", "-show_entries",
                   "stream=width,height", "-of", "csv=p=0", str(clip)]).stdout
        _dims[clip] = tuple(map(int, out.strip().split(",")[:2]))
    return _dims[clip]


def fit_through_origin(samples):
    """Least squares k = sum(c_i * f_i) with no intercept; samples are (features, k)."""
    n = len(samples[0][0])
    # Normal equations, solved by Gaussian elimination (n is 1 or 2).
    m = [[sum(f[i] * f[j] for f, _ in samples) for j in range(n)] + [sum(f[i] * k for f, k in samples)]
         for i in range(n)]
    for i in range(n):
        for r in range(n):
            if r != i:
                q = m[r][i] / m[i][i]
                m[r] = [a - q * b for a, b in zip(m[r], m[i])]
    return [m[i][n] / m[i][i] for i in range(n)]


def predict(coefs, f):
    return sum(c * x for c, x in zip(coefs, f))


def ratios(coefs, samples):
    """actual / predicted for each sample."""
    return [k / predict(coefs, f) for f, k in samples]


def feature_name(kind, thr):
    return f"{kind}{thr}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ffmpeg", required=True, help="ffmpeg matching the browser build (see build-ffmpeg.sh)")
    ap.add_argument("--prep-ffmpeg", default="ffmpeg",
                    help="ffmpeg used to decode sources into 540p lossless clips (needs e.g. AV1 support)")
    ap.add_argument("--source", action="append", required=True, help="source video (repeatable)")
    ap.add_argument("--positions", default="10,20,35,45,60,70,85,95", help="clip start points, %% of duration")
    ap.add_argument("--duration", type=float, default=6.0)
    ap.add_argument("--heights", default="360,540,720")
    ap.add_argument("--fps", default="10,15,25")
    ap.add_argument("--dithers", default=",".join(DITHERS))
    ap.add_argument("--work", default=str(Path(__file__).with_name(".cache") / "work"))
    ap.add_argument("--out", help="write the model JSON here")
    ap.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    a = ap.parse_args()

    heights = [int(x) for x in a.heights.split(",")]
    fpss = [float(x) if "." in x else int(x) for x in a.fps.split(",")]
    dithers = a.dithers.split(",")
    positions = [float(x) for x in a.positions.split(",")]
    work = Path(a.work)
    (work / "clips").mkdir(parents=True, exist_ok=True)
    (work / "gifs").mkdir(exist_ok=True)
    (work / "feat").mkdir(exist_ok=True)
    prep_probe = shutil.which("ffprobe") if a.prep_ffmpeg == "ffmpeg" else str(Path(a.prep_ffmpeg).with_name("ffprobe"))
    version = run([a.ffmpeg, "-version"]).stdout.split()[2]

    # 1. Lossless scaled clips.
    clips = []  # (name, height, path)
    t0 = time.time()
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = []
        for src in a.source:
            dur = probe_duration(prep_probe, src)
            stem = "".join(c if c.isalnum() else "_" for c in Path(src).stem)[:40]
            for pos in positions:
                start = max(0.0, min(dur * pos / 100, dur - a.duration - 1))
                for h in heights:
                    out = work / "clips" / f"{stem}_{int(pos)}_{h}.mkv"
                    clips.append((f"{stem}_{int(pos)}", h, out))
                    futs.append(ex.submit(make_clip, a.prep_ffmpeg, src, start, a.duration, h, out))
        for f in cf.as_completed(futs):
            f.result()
    print(f"clips: {len(clips)} in {time.time() - t0:.0f}s", file=sys.stderr)

    # 2. Encodes and features.
    t0 = time.time()
    rows = []  # dict per (clip, height, fps, dither)
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        enc, feat = {}, {}
        for name, h, path in clips:
            for fps in fpss:
                for d in dithers:
                    gif = work / "gifs" / f"{path.stem}_f{fps}_{d}.gif"
                    enc[(name, h, fps, d)] = ex.submit(encode, a.ffmpeg, path, fps, d, gif)
                for kind, thr in FEATURES:
                    cache = work / "feat" / f"{path.stem}_f{fps}_{kind}{thr}.sum"
                    feat[(name, h, fps, kind, thr)] = ex.submit(feature_sum, a.ffmpeg, path, fps, kind, thr, cache)
        for (name, h, fps, d), fut in enc.items():
            k, w, hh, n = fut.result()
            # Per-clip feature: mean over the n GIF frames, the first counting as fully changed
            # (tblend emits n-1 differences).
            rows.append(dict(clip=name, source=name.rsplit("_", 1)[0], height=h, fps=fps, dither=d, k=k, frames=n,
                             **{f"{kind}{thr}": (1 + feat[(name, h, fps, kind, thr)].result()) / n
                                for kind, thr in FEATURES}))
    print(f"encodes: {len(rows)} in {time.time() - t0:.0f}s", file=sys.stderr)
    (work / "rows.json").write_text(json.dumps(rows, indent=1))

    # 3. Fit. Candidates are k = c*f and k = c1*f1 + c2*f2 (non-negative c), scored by
    # leave-one-source-out cross-validation, since the question is how the model does on
    # footage it has never seen. In each fold the candidate is fitted on the other sources,
    # its margin is the 90th percentile of actual/predicted there (the worst clip lets one
    # outlier dominate), and the held-out source's clips are scored by budget utilisation,
    # min(1, actual / (margin * predicted)): how much of the size budget a GIF planned with
    # this model uses. Candidates whose worst held-out clip lands more than MAX_OVERSHOOT
    # over budget are only used if nothing else qualifies.
    names = sorted({r["clip"] for r in rows})
    sources = sorted({r["source"] for r in rows})
    keys = [(kind, thr) for kind, thr in FEATURES]
    candidates = [(k,) for k in keys] + list(itertools.combinations(keys, 2))
    model = {"ffmpeg": version, "statsMode": "diff", "fpsCalibrated": fpss,
             "clips": len(names), "sources": len(a.source), "models": {}}
    for d in dithers:
        def samples(combo, keep):
            return [([r[feature_name(*c)] for c in combo], r["k"]) for r in rows if r["dither"] == d and keep(r)]
        scored = []
        for combo in candidates:
            scaled = []  # held-out actual / (margin * predicted), across all folds
            valid = True
            for held in sources:
                tr = samples(combo, lambda r: r["source"] != held)
                te = samples(combo, lambda r: r["source"] == held)
                coefs = fit_through_origin(tr)
                if any(c <= 0 for c in coefs):
                    valid = False
                    break
                margin = percentile(ratios(coefs, tr), MARGIN_PERCENTILE)
                scaled += [q / margin for q in ratios(coefs, te)]
            if not valid:
                continue
            util = sum(min(1, q) for q in scaled) / len(scaled)
            over = sum(q > 1 for q in scaled) / len(scaled)
            err = sum(abs(1 / q - 1) for q in scaled) / len(scaled)
            # Prefer one feature over two unless the pair is clearly better.
            scored.append((util - 0.01 * (len(combo) - 1), util, over, err, max(scaled), combo))
        # Rank candidates within the overshoot limit by utilisation; if none qualify, take
        # the one whose worst held-out clip overshoots least.
        ok = [s for s in scored if s[4] <= 1 + MAX_OVERSHOOT]
        scored = sorted(ok, key=lambda s: -s[0]) if ok else sorted(scored, key=lambda s: s[4])
        print(f"\n{d}: {'features':22}{'test util':>10}{'over budget':>12}{'worst':>7}{'mean err':>9}")
        for _, util, over, err, worst, combo in scored[:4]:
            print(f"  {'+'.join(feature_name(*c) for c in combo):22}{util * 100:9.0f}%{over * 100:11.0f}%"
                  f"{worst:7.2f}{err * 100:8.0f}%")
        _, test_util, test_over, test_err, test_worst, combo = scored[0]

        # Final: coefficients per height on all clips, margin from all of them.
        by_height, all_ratios = {}, []
        for h in heights:
            s = samples(combo, lambda r: r["height"] == h)
            coefs = fit_through_origin(s)
            all_ratios += ratios(coefs, s)
            by_height[str(h)] = [round(c, 4) for c in coefs]
        margin = math.ceil(percentile(all_ratios, MARGIN_PERCENTILE) * 100) / 100
        model["models"][d] = {
            "features": [{"kind": kind, "threshold": thr} for kind, thr in combo],
            "coefsByHeight": by_height,
            "margin": margin,
            "heldOut": {"meanErr": round(test_err, 3), "utilization": round(test_util, 3),
                        "overBudget": round(test_over, 3), "worstOverBudget": round(test_worst - 1, 3)},
        }
        print(f"  -> {'+'.join(feature_name(*c) for c in combo)}, coefs {by_height}, margin {margin}")
    if a.out:
        Path(a.out).write_text(json.dumps(model, indent=2) + "\n")
        print(f"wrote {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
