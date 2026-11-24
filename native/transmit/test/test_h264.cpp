// Unit tests for the pure H.264-path parts: ImageOps.h (size fit, scale,
// BGRA -> NV12) and AnnexB.h (NAL split, SPS/PPS prepending).
#include <cstdio>
#include <cstdlib>

#include "../src/AnnexB.h"
#include "../src/ImageOps.h"

static int g_fail = 0;
#define CHECK(c)                                                       \
    do {                                                               \
        if (!(c)) {                                                    \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c);   \
            ++g_fail;                                                  \
        }                                                              \
    } while (0)

using namespace otx;
using Bytes = std::vector<uint8_t>;

static void Fill(Bytes& img, int w, int h, uint8_t b, uint8_t g, uint8_t r) {
    img.resize(static_cast<size_t>(w) * h * 4);
    for (size_t i = 0; i < img.size(); i += 4) {
        img[i] = b;
        img[i + 1] = g;
        img[i + 2] = r;
        img[i + 3] = 255;
    }
}

static void TestColours() {
    struct C { uint8_t b, g, r; int y, cb, cr; } cases[] = {
        {255, 255, 255, 235, 128, 128},  // white
        {0, 0, 0, 16, 128, 128},         // black
        {128, 128, 128, 126, 128, 128},  // mid grey: Y=16+219*128/255 ~ 126
        {0, 0, 255, 63, 102, 240},       // red   (BT.709: Y 63, Cb 102, Cr 240)
        {0, 255, 0, 173, 42, 26},        // green (Y 173, Cb 42, Cr 26)
        {255, 0, 0, 32, 240, 118},       // blue  (Y 32, Cb 240, Cr 118)
    };
    for (const auto& c : cases) {
        Bytes img, nv(4 * 4 * 3 / 2);
        Fill(img, 4, 4, c.b, c.g, c.r);
        BgraToNv12(img.data(), 16, 4, 4, nv.data());
        auto near = [](int a, int b) { return std::abs(a - b) <= 2; };
        CHECK(near(nv[0], c.y));
        CHECK(near(nv[15], c.y));
        CHECK(near(nv[16], c.cb));
        CHECK(near(nv[17], c.cr));
        CHECK(near(nv[22], c.cb));
        CHECK(near(nv[23], c.cr));
    }
    // limited-range bounds are exact
    Bytes img, nv(2 * 2 * 3 / 2);
    Fill(img, 2, 2, 255, 255, 255);
    BgraToNv12(img.data(), 8, 2, 2, nv.data());
    CHECK(nv[0] == 235 && nv[4] == 128 && nv[5] == 128);
    Fill(img, 2, 2, 0, 0, 0);
    BgraToNv12(img.data(), 8, 2, 2, nv.data());
    CHECK(nv[0] == 16 && nv[4] == 128 && nv[5] == 128);
}

static void TestLayoutStrideCrop() {
    // 6x4 source with stride padding (32 bytes/row instead of 24); convert only the left 4x4.
    const size_t stride = 32;
    Bytes img(stride * 4, 0);
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 6; ++x) {
            uint8_t* p = &img[y * stride + x * 4];
            // left half white, right 2 columns black
            const uint8_t v = x < 4 ? 255 : 0;
            p[0] = p[1] = p[2] = v;
            p[3] = 255;
        }
    Bytes nv(4 * 4 * 3 / 2, 0);
    BgraToNv12(img.data(), stride, 4, 4, nv.data());
    for (int i = 0; i < 16; ++i) CHECK(nv[i] == 235);
    CHECK(nv[16] == 128 && nv[17] == 128);

    // 2x2 chroma averaging: left column red, right column blue -> averaged colour
    Bytes px(2 * 2 * 4);
    uint8_t* p = px.data();
    p[0] = 0; p[1] = 0; p[2] = 255; p[3] = 255;       // (0,0) red
    p[4] = 255; p[5] = 0; p[6] = 0; p[7] = 255;       // (1,0) blue
    p[8] = 0; p[9] = 0; p[10] = 255; p[11] = 255;     // (0,1) red
    p[12] = 255; p[13] = 0; p[14] = 0; p[15] = 255;   // (1,1) blue
    Bytes o(6);
    BgraToNv12(px.data(), 8, 2, 2, o.data());
    CHECK(o[0] == RgbToY(255, 0, 0) && o[1] == RgbToY(0, 0, 255));
    CHECK(o[4] == RgbToCb(128, 0, 128) && o[5] == RgbToCr(128, 0, 128));
}

static void TestFitAndScale() {
    int w, h;
    FitEven(1280, 720, 1920, 1080, w, h);
    CHECK(w == 1280 && h == 720);
    FitEven(1920, 1080, 1920, 1080, w, h);
    CHECK(w == 1920 && h == 1080);
    FitEven(3840, 2160, 1920, 1080, w, h);
    CHECK(w == 1920 && h == 1080);
    FitEven(4096, 2160, 1920, 1080, w, h);
    CHECK(w == 1920 && h == 1012);  // 1012.5 -> 1012 (even)
    FitEven(1080, 1920, 1920, 1080, w, h);
    CHECK(w == 1080 && h == 1920);  // portrait keeps 1080x1920
    FitEven(2160, 3840, 1920, 1080, w, h);
    CHECK(w == 1080 && h == 1920);
    FitEven(1281, 721, 1920, 1080, w, h);
    CHECK(w == 1280 && h == 720);   // odd sizes round down to even
    FitEven(1, 1, 1920, 1080, w, h);
    CHECK(w == 2 && h == 2);
    FitEven(7680, 1080, 1920, 1080, w, h);
    CHECK(w == 1920 && h == 270);

    // box scale 4x4 -> 2x2 averages 2x2 blocks
    Bytes src(4 * 4 * 4), dst;
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 4; ++x) {
            uint8_t* p = &src[(y * 4 + x) * 4];
            const uint8_t v = (x < 2) ? ((y < 2) ? 0 : 100) : ((y < 2) ? 200 : 40);
            p[0] = p[1] = p[2] = v;
            p[3] = 255;
        }
    ScaleBgraBox(src.data(), 4, 4, 2, 2, dst);
    CHECK(dst.size() == 16);
    CHECK(dst[0] == 0 && dst[4] == 200 && dst[8] == 100 && dst[12] == 40);
    CHECK(dst[3] == 255);
    // non-integer ratio does not read out of bounds (run under -fsanitize in CI if wanted)
    Bytes big(1000 * 563 * 4, 7);
    ScaleBgraBox(big.data(), 1000, 563, 640, 360, dst);
    CHECK(dst.size() == 640u * 360u * 4u && dst[0] == 7 && dst.back() == 255);
}

static Bytes Cat(std::initializer_list<Bytes> parts) {
    Bytes o;
    for (const auto& p : parts) o.insert(o.end(), p.begin(), p.end());
    return o;
}

static void TestAnnexB() {
    const Bytes sps = {0, 0, 0, 1, 0x67, 0x42, 0xE0, 0x28, 0xDA};
    const Bytes pps = {0, 0, 0, 1, 0x68, 0xCE, 0x3C, 0x80};
    const Bytes idr = {0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x10};
    const Bytes pslice = {0, 0, 1, 0x41, 0x9A, 0x22, 0x00};  // 3-byte start code
    const Bytes aud = {0, 0, 0, 1, 0x09, 0xF0};

    auto nals = SplitAnnexB(idr.data(), idr.size());
    CHECK(nals.size() == 1 && nals[0].type == kNalIdr && nals[0].start == 0 && nals[0].payload == 4 && nals[0].end == idr.size());

    Bytes au = Cat({aud, sps, pps, idr});
    nals = SplitAnnexB(au.data(), au.size());
    CHECK(nals.size() == 4);
    CHECK(nals[0].type == kNalAud && nals[1].type == kNalSps && nals[2].type == kNalPps && nals[3].type == kNalIdr);
    CHECK(nals[1].end - nals[1].start == sps.size());  // start code included, next start code excluded

    Bytes cache, out;
    bool key = false;
    // full keyframe: AUD dropped, content identical to sps+pps+idr, cache filled
    CHECK(PrepareAccessUnit(au.data(), au.size(), cache, out, key));
    CHECK(key);
    CHECK(out == Cat({sps, pps, idr}));
    CHECK(cache == Cat({sps, pps}));

    // delta frame (3-byte start code kept as is)
    CHECK(PrepareAccessUnit(pslice.data(), pslice.size(), cache, out, key));
    CHECK(!key && out == pslice);

    // keyframe without SPS/PPS gets the cached ones in front
    CHECK(PrepareAccessUnit(idr.data(), idr.size(), cache, out, key));
    CHECK(key && out == Cat({sps, pps, idr}));

    // keyframe with only a PPS: the cached pair replaces it, no duplicates
    Bytes half = Cat({pps, idr});
    CHECK(PrepareAccessUnit(half.data(), half.size(), cache, out, key));
    CHECK(key && out == Cat({sps, pps, idr}));

    // no cache and no parameter sets: passed through unchanged
    Bytes none, o2;
    CHECK(PrepareAccessUnit(idr.data(), idr.size(), none, o2, key));
    CHECK(key && o2 == idr);

    // ExtractParamSets normalises 3-byte start codes to 4 bytes
    Bytes sps3 = {0, 0, 1, 0x67, 0x42, 0xE0, 0x28};
    Bytes ps;
    ExtractParamSets(sps3.data(), sps3.size(), ps);
    CHECK(ps == (Bytes{0, 0, 0, 1, 0x67, 0x42, 0xE0, 0x28}));

    // garbage / empty
    Bytes junk = {1, 2, 3, 4};
    CHECK(!PrepareAccessUnit(junk.data(), junk.size(), cache, out, key));
    CHECK(!PrepareAccessUnit(junk.data(), 0, cache, out, key));
}

int main() {
    TestColours();
    TestLayoutStrideCrop();
    TestFitAndScale();
    TestAnnexB();
    if (g_fail) {
        std::printf("test_h264: %d failure(s)\n", g_fail);
        return 1;
    }
    std::printf("test_h264: ok\n");
    return 0;
}
