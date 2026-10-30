// A thin decoding API over FFmpeg's libavcodec, compiled to WebAssembly for the preview
// player. It decodes codecs the browser's WebCodecs can't (e.g. 10-bit H.264, AC-3, DTS).
// Demuxing happens in JavaScript (Mediabunny); this only turns packets into frames.
//
// Video frames come out as 8-bit I420 (planes Y, U, V, tightly packed); audio as planar
// 32-bit float. Timestamps are microseconds in, seconds out.

#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <math.h>
#include <string.h>

typedef struct {
    AVCodecContext *ctx;
    AVPacket *pkt;
    AVFrame *frame;
    struct SwsContext *sws;
    SwrContext *swr;
    int swr_fmt, swr_rate, swr_channels;
    uint8_t *out;
    int out_cap, out_size;
    int width, height;
    int samples, channels, rate;
    double pts;
} Decoder;

EMSCRIPTEN_KEEPALIVE void dec_close(Decoder *d) {
    if (!d) return;
    avcodec_free_context(&d->ctx);
    av_packet_free(&d->pkt);
    av_frame_free(&d->frame);
    sws_freeContext(d->sws);
    swr_free(&d->swr);
    av_free(d->out);
    av_free(d);
}

/** 1 if this build has a decoder with the given FFmpeg name. */
EMSCRIPTEN_KEEPALIVE int dec_has(const char *name) {
    return avcodec_find_decoder_by_name(name) != NULL;
}

/**
 * Open a decoder by FFmpeg name (e.g. "h264", "ac3"). extradata is the codec
 * configuration (avcC, hvcC, AudioSpecificConfig, OpusHead, ...), or NULL.
 */
EMSCRIPTEN_KEEPALIVE Decoder *dec_open(const char *name, const uint8_t *extra, int extra_size,
                                       int width, int height, int rate, int channels) {
    const AVCodec *codec = avcodec_find_decoder_by_name(name);
    if (!codec) return NULL;
    Decoder *d = av_mallocz(sizeof *d);
    if (!d) return NULL;
    d->ctx = avcodec_alloc_context3(codec);
    d->pkt = av_packet_alloc();
    d->frame = av_frame_alloc();
    if (!d->ctx || !d->pkt || !d->frame) goto fail;
    d->ctx->pkt_timebase = (AVRational){1, 1000000};
    if (extra && extra_size > 0) {
        d->ctx->extradata = av_mallocz(extra_size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (!d->ctx->extradata) goto fail;
        memcpy(d->ctx->extradata, extra, extra_size);
        d->ctx->extradata_size = extra_size;
    }
    if (codec->type == AVMEDIA_TYPE_VIDEO) {
        d->ctx->width = width;
        d->ctx->height = height;
    } else {
        d->ctx->sample_rate = rate;
        av_channel_layout_default(&d->ctx->ch_layout, channels > 0 ? channels : 2);
    }
    if (avcodec_open2(d->ctx, codec, NULL) < 0) goto fail;
    return d;
fail:
    dec_close(d);
    return NULL;
}

/**
 * Send one packet. Returns 0 on success, 1 if the decoder is full (receive frames,
 * then send the same packet again), or a negative FFmpeg error.
 */
EMSCRIPTEN_KEEPALIVE int dec_send(Decoder *d, const uint8_t *data, int size, double pts_us, int key) {
    av_packet_unref(d->pkt);
    if (av_new_packet(d->pkt, size) < 0) return AVERROR(ENOMEM);
    memcpy(d->pkt->data, data, size);
    d->pkt->pts = (int64_t)llround(pts_us);
    d->pkt->dts = AV_NOPTS_VALUE;
    if (key) d->pkt->flags |= AV_PKT_FLAG_KEY;
    int r = avcodec_send_packet(d->ctx, d->pkt);
    return r == AVERROR(EAGAIN) ? 1 : r;
}

/** Signal end of stream, so the remaining frames can be received. */
EMSCRIPTEN_KEEPALIVE int dec_flush(Decoder *d) {
    int r = avcodec_send_packet(d->ctx, NULL);
    return r == AVERROR_EOF ? 0 : r;
}

/** Drop all buffered state, e.g. before decoding from a new position. */
EMSCRIPTEN_KEEPALIVE void dec_reset(Decoder *d) {
    avcodec_flush_buffers(d->ctx);
}

static int ensure_out(Decoder *d, int size) {
    if (size <= d->out_cap) return 0;
    av_free(d->out);
    d->out = av_malloc(size);
    d->out_cap = d->out ? size : 0;
    return d->out ? 0 : AVERROR(ENOMEM);
}

static int convert_video(Decoder *d, AVFrame *f) {
    int w = f->width, h = f->height;
    int size = av_image_get_buffer_size(AV_PIX_FMT_YUV420P, w, h, 1);
    if (size < 0 || ensure_out(d, size) < 0) return AVERROR(ENOMEM);
    uint8_t *dst[4];
    int dst_linesize[4];
    av_image_fill_arrays(dst, dst_linesize, d->out, AV_PIX_FMT_YUV420P, w, h, 1);
    if (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P) {
        av_image_copy2(dst, dst_linesize, f->data, f->linesize, AV_PIX_FMT_YUV420P, w, h);
    } else {
        // Other formats (10-bit, 4:2:2, 4:4:4, ...) are converted to 8-bit 4:2:0.
        d->sws = sws_getCachedContext(d->sws, w, h, f->format, w, h, AV_PIX_FMT_YUV420P,
                                      SWS_BILINEAR, NULL, NULL, NULL);
        if (!d->sws) return AVERROR(EINVAL);
        sws_scale(d->sws, (const uint8_t *const *)f->data, f->linesize, 0, h, dst, dst_linesize);
    }
    d->out_size = size;
    d->width = w;
    d->height = h;
    return 0;
}

static int convert_audio(Decoder *d, AVFrame *f) {
    int channels = f->ch_layout.nb_channels, n = f->nb_samples;
    int size = channels * n * (int)sizeof(float);
    if (ensure_out(d, size) < 0) return AVERROR(ENOMEM);
    if (f->format == AV_SAMPLE_FMT_FLTP) {
        for (int c = 0; c < channels; c++) memcpy(d->out + c * n * 4, f->extended_data[c], n * 4);
    } else {
        if (!d->swr || d->swr_fmt != f->format || d->swr_rate != f->sample_rate || d->swr_channels != channels) {
            swr_free(&d->swr);
            if (swr_alloc_set_opts2(&d->swr, &f->ch_layout, AV_SAMPLE_FMT_FLTP, f->sample_rate,
                                    &f->ch_layout, f->format, f->sample_rate, 0, NULL) < 0 ||
                swr_init(d->swr) < 0)
                return AVERROR(EINVAL);
            d->swr_fmt = f->format;
            d->swr_rate = f->sample_rate;
            d->swr_channels = channels;
        }
        uint8_t *planes[64];
        if (channels > 64) return AVERROR(EINVAL);
        for (int c = 0; c < channels; c++) planes[c] = d->out + c * n * 4;
        int got = swr_convert(d->swr, planes, n, (const uint8_t **)f->extended_data, n);
        if (got < 0) return got;
        n = got;
        size = channels * n * 4;
    }
    d->out_size = size;
    d->samples = n;
    d->channels = channels;
    d->rate = f->sample_rate;
    return 0;
}

/**
 * Receive the next decoded frame into the output buffer. Returns 1 if a frame is
 * ready, 0 if the decoder needs more input, -2 at end of stream, or a negative error.
 */
EMSCRIPTEN_KEEPALIVE int dec_receive(Decoder *d) {
    int r = avcodec_receive_frame(d->ctx, d->frame);
    if (r == AVERROR(EAGAIN)) return 0;
    if (r == AVERROR_EOF) return -2;
    if (r < 0) return r;
    int64_t ts = d->frame->best_effort_timestamp;
    if (ts == AV_NOPTS_VALUE) ts = d->frame->pts;
    d->pts = ts == AV_NOPTS_VALUE ? NAN : ts / 1e6;
    r = d->ctx->codec_type == AVMEDIA_TYPE_VIDEO ? convert_video(d, d->frame) : convert_audio(d, d->frame);
    av_frame_unref(d->frame);
    return r < 0 ? r : 1;
}

EMSCRIPTEN_KEEPALIVE uint8_t *dec_out(Decoder *d) { return d->out; }
EMSCRIPTEN_KEEPALIVE int dec_out_size(Decoder *d) { return d->out_size; }
EMSCRIPTEN_KEEPALIVE int dec_width(Decoder *d) { return d->width; }
EMSCRIPTEN_KEEPALIVE int dec_height(Decoder *d) { return d->height; }
EMSCRIPTEN_KEEPALIVE int dec_samples(Decoder *d) { return d->samples; }
EMSCRIPTEN_KEEPALIVE int dec_channels(Decoder *d) { return d->channels; }
EMSCRIPTEN_KEEPALIVE int dec_rate(Decoder *d) { return d->rate; }
EMSCRIPTEN_KEEPALIVE double dec_pts(Decoder *d) { return d->pts; }
