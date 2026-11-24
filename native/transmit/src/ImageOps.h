// Pocket Monitor — native Transmit plugin
// Pixel helpers for the H.264 path: size fitting, box downscale and the
// BGRA -> NV12 converter (BT.709, limited range). Pure C++, unit-tested.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace otx {

// Largest even size that fits maxLong x maxShort (landscape) or maxShort x
// maxLong (portrait), keeping the aspect ratio. Never upscales. Sizes below 2
// become 2.
inline void FitEven(int w, int h, int maxLong, int maxShort, int& outW, int& outH) {
    const int boxW = w >= h ? maxLong : maxShort;
    const int boxH = w >= h ? maxShort : maxLong;
    int ow = w, oh = h;
    if (w > boxW || h > boxH) {
        // scale = min(boxW / w, boxH / h), computed in integers
        if (static_cast<int64_t>(boxW) * h <= static_cast<int64_t>(boxH) * w) {
            ow = boxW;
            oh = static_cast<int>((static_cast<int64_t>(h) * boxW + w / 2) / w);
        } else {
            oh = boxH;
            ow = static_cast<int>((static_cast<int64_t>(w) * boxH + h / 2) / h);
        }
    }
    outW = std::max(2, ow & ~1);
    outH = std::max(2, oh & ~1);
}

// Box-filter downscale of top-down BGRA (tightly packed rows) to outW x outH.
inline void ScaleBgraBox(const uint8_t* src, int sw, int sh, int outW, int outH, std::vector<uint8_t>& dst) {
    dst.resize(static_cast<size_t>(outW) * outH * 4);
    const size_t srcStride = static_cast<size_t>(sw) * 4;
    std::vector<int> x0(outW), x1(outW);
    for (int x = 0; x < outW; ++x) {
        x0[x] = static_cast<int>(static_cast<int64_t>(x) * sw / outW);
        x1[x] = std::max(x0[x] + 1, static_cast<int>(static_cast<int64_t>(x + 1) * sw / outW));
    }
    std::vector<uint32_t> acc(static_cast<size_t>(outW) * 4);
    for (int y = 0; y < outH; ++y) {
        const int y0 = static_cast<int>(static_cast<int64_t>(y) * sh / outH);
        const int y1 = std::max(y0 + 1, static_cast<int>(static_cast<int64_t>(y + 1) * sh / outH));
        std::fill(acc.begin(), acc.end(), 0u);
        for (int sy = y0; sy < y1; ++sy) {
            const uint8_t* row = src + sy * srcStride;
            for (int x = 0; x < outW; ++x) {
                uint32_t b = 0, g = 0, r = 0;
                const uint8_t* px = row + static_cast<size_t>(x0[x]) * 4;
                for (int sx = x0[x]; sx < x1[x]; ++sx, px += 4) {
                    b += px[0];
                    g += px[1];
                    r += px[2];
                }
                uint32_t* a = &acc[static_cast<size_t>(x) * 4];
                a[0] += b;
                a[1] += g;
                a[2] += r;
            }
        }
        uint8_t* out = dst.data() + static_cast<size_t>(y) * outW * 4;
        const int rows = y1 - y0;
        for (int x = 0; x < outW; ++x) {
            const uint32_t n = static_cast<uint32_t>(rows * (x1[x] - x0[x]));
            const uint32_t* a = &acc[static_cast<size_t>(x) * 4];
            out[0] = static_cast<uint8_t>((a[0] + n / 2) / n);
            out[1] = static_cast<uint8_t>((a[1] + n / 2) / n);
            out[2] = static_cast<uint8_t>((a[2] + n / 2) / n);
            out[3] = 255;
            out += 4;
        }
    }
}

// BT.709 limited-range RGB -> YCbCr, 8-bit integer maths (coefficients x256).
//   Y  =  16 + (  47 R + 157 G +  16 B) / 256       white 235, black 16
//   Cb = 128 + ( -26 R -  87 G + 113 B) / 256       range 16..240
//   Cr = 128 + ( 112 R - 102 G -  10 B) / 256
// The Cb/Cr rows sum to exactly 0, so greys land on 128.
inline uint8_t RgbToY(int r, int g, int b) { return static_cast<uint8_t>(16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)); }
inline uint8_t RgbToCb(int r, int g, int b) {
    return static_cast<uint8_t>(128 + ((-26 * r - 87 * g + 113 * b + 128) >> 8));
}
inline uint8_t RgbToCr(int r, int g, int b) {
    return static_cast<uint8_t>(128 + ((112 * r - 102 * g - 10 * b + 128) >> 8));
}

// Converts the top-left outW x outH (both even) of a top-down BGRA image to
// planar-Y + interleaved-CbCr NV12 (tightly packed: Y plane outW*outH, then
// UV plane outW*outH/2). Chroma is the average of each 2x2 block (centre-sited).
inline void BgraToNv12(const uint8_t* bgra, size_t srcStrideBytes, int outW, int outH, uint8_t* nv12) {
    uint8_t* yPlane = nv12;
    uint8_t* uvPlane = nv12 + static_cast<size_t>(outW) * outH;
    for (int y = 0; y < outH; y += 2) {
        const uint8_t* r0 = bgra + static_cast<size_t>(y) * srcStrideBytes;
        const uint8_t* r1 = r0 + srcStrideBytes;
        uint8_t* y0 = yPlane + static_cast<size_t>(y) * outW;
        uint8_t* y1 = y0 + outW;
        uint8_t* uv = uvPlane + static_cast<size_t>(y / 2) * outW;
        for (int x = 0; x < outW; x += 2) {
            const uint8_t* p00 = r0 + x * 4;
            const uint8_t* p01 = p00 + 4;
            const uint8_t* p10 = r1 + x * 4;
            const uint8_t* p11 = p10 + 4;
            y0[x] = RgbToY(p00[2], p00[1], p00[0]);
            y0[x + 1] = RgbToY(p01[2], p01[1], p01[0]);
            y1[x] = RgbToY(p10[2], p10[1], p10[0]);
            y1[x + 1] = RgbToY(p11[2], p11[1], p11[0]);
            const int r = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
            const int g = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
            const int b = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
            uv[x] = RgbToCb(r, g, b);
            uv[x + 1] = RgbToCr(r, g, b);
        }
    }
}

} // namespace otx
