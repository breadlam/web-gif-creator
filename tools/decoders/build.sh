#!/usr/bin/env bash
# Build the preview decoder module: FFmpeg's decoders compiled to WebAssembly with a thin
# C API (decoder.c). Runs inside the emscripten/emsdk image; see build-docker.sh.
#
# Inputs:  /src (this directory), /build (cache; holds the FFmpeg tarball)
# Output:  /out/decoder.mjs and /out/decoder.wasm
set -euo pipefail

FFMPEG_VERSION=8.1.3
# Video decoders the browser may lack (e.g. 10-bit H.264/HEVC), and audio decoders for
# codecs browsers rarely play in video files (AC-3, E-AC-3, DTS, TrueHD, FLAC in MKV...).
VIDEO=h264,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,vp3,theora,mjpeg
AUDIO=aac,aac_latm,mp3float,mp2float,flac,opus,vorbis,ac3,eac3,dca,truehd,mlp,alac
AUDIO+=,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_bluray,pcm_dvd

export EM_CACHE=/build/emcache
cd /build
[ -d ffmpeg-$FFMPEG_VERSION ] || tar -xJf ffmpeg-$FFMPEG_VERSION.tar.xz
cd ffmpeg-$FFMPEG_VERSION

if [ ! -f /build/prefix/lib/libavcodec.a ]; then
  emconfigure ./configure \
    --prefix=/build/prefix \
    --target-os=none --arch=wasm --enable-cross-compile \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --disable-everything --disable-programs --disable-doc --disable-debug \
    --disable-network --disable-autodetect --disable-pthreads --disable-runtime-cpudetect \
    --disable-avformat --disable-avfilter --disable-avdevice \
    --enable-decoder=$VIDEO,$AUDIO \
    --extra-cflags="-O3 -msimd128" \
    > /build/configure.log
  make -j"$(nproc)" > /build/make.log 2>&1
  make install > /dev/null
fi

FUNCS=dec_has,dec_open,dec_send,dec_flush,dec_reset,dec_receive,dec_close
FUNCS+=,dec_out,dec_out_size,dec_width,dec_height,dec_samples,dec_channels,dec_rate,dec_pts
EXPORTS=$(echo "_malloc,_free,$FUNCS" | sed 's/,dec_/,_dec_/g')

emcc -O3 -msimd128 /src/decoder.c \
  -I/build/prefix/include \
  /build/prefix/lib/libavcodec.a /build/prefix/lib/libswscale.a \
  /build/prefix/lib/libswresample.a /build/prefix/lib/libavutil.a \
  -o /out/decoder.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDecoderModule \
  -sENVIRONMENT=web,worker -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,stringToNewUTF8

echo "built: $(ls -l /out/decoder.mjs /out/decoder.wasm | awk '{print $5, $9}' | tr '\n' ' ')"
