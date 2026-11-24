// OTX1 serialiser tests. Writes golden.bin (a stream of messages built with the
// plugin's real serialiser) for check_golden.js, which parses it with the
// helper's helper/lib/otx1.js. Also tests the helper -> plugin reader.
#include <cstdio>
#include <string>

#include "../src/Otx1.h"

static int g_fail = 0;
#define CHECK(c)                                                       \
    do {                                                               \
        if (!(c)) {                                                    \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c);   \
            ++g_fail;                                                  \
        }                                                              \
    } while (0)

using namespace otx;

static void Append(std::vector<uint8_t>& s, uint32_t& seq, uint8_t type, const std::vector<uint8_t>& meta,
                   const std::vector<uint8_t>& body) {
    uint8_t h[kHeaderSize];
    BuildHeader(h, type, static_cast<uint32_t>(meta.size() + body.size()), seq++);
    s.insert(s.end(), h, h + kHeaderSize);
    s.insert(s.end(), meta.begin(), meta.end());
    s.insert(s.end(), body.begin(), body.end());
}

static void TestIncoming() {
    // 64 (empty), 65 json, an oversized unknown type that must be skipped, 65 again; fed 1 byte at a time.
    std::vector<uint8_t> in;
    uint32_t seq = 0;
    Append(in, seq, kMsgRequestKeyframe, {}, {});
    const std::string j1 = "{\"jpeg\":false}", j2 = "{ \"jpeg\" : true }";
    Append(in, seq, kMsgJpegWanted, {}, std::vector<uint8_t>(j1.begin(), j1.end()));
    Append(in, seq, 99, {}, std::vector<uint8_t>(10000, 0xAA));  // > maxPayload (4096): skipped
    Append(in, seq, kMsgJpegWanted, {}, std::vector<uint8_t>(j2.begin(), j2.end()));

    IncomingParser p;
    int keyReq = 0;
    std::vector<int> wanted;
    int unknown = 0;
    bool ok = true;
    for (uint8_t b : in) {
        ok = ok && p.Feed(&b, 1, [&](uint8_t type, const uint8_t* d, size_t n) {
            if (type == kMsgRequestKeyframe) ++keyReq;
            else if (type == kMsgJpegWanted) {
                bool w;
                if (ParseJpegWanted(d, n, w)) wanted.push_back(w ? 1 : 0);
            } else ++unknown;
        });
    }
    CHECK(ok);
    CHECK(keyReq == 1);
    CHECK(wanted.size() == 2 && wanted[0] == 0 && wanted[1] == 1);
    CHECK(unknown == 0);

    // bad magic is reported
    IncomingParser q;
    const uint8_t bad[16] = {'X', 'T', 'X', 'F'};
    CHECK(!q.Feed(bad, sizeof(bad), [](uint8_t, const uint8_t*, size_t) {}));

    bool w = true;
    const std::string nothing = "{}";
    CHECK(!ParseJpegWanted(reinterpret_cast<const uint8_t*>(nothing.data()), nothing.size(), w));
}

static void WriteGolden(const char* path) {
    std::vector<uint8_t> s;
    uint32_t seq = 0;

    // type 1: JPEG-ish bytes (only the SOI matters to the parser)
    std::vector<uint8_t> meta1(kJpegMetaSize);
    BuildJpegMeta(meta1.data(), 1280, 720, 1920, 1080, 254016000000LL * 5 + 123, 30000, 1001);
    Append(s, seq, kMsgVideoJpeg, meta1, {0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9});

    // type 3 heartbeat
    Append(s, seq, kMsgHeartbeat, {}, {});

    // type 4 keyframe: SPS, PPS, IDR
    std::vector<uint8_t> meta4(kH264MetaSize);
    BuildH264Meta(meta4.data(), true, 1920, 1080, 254016000000LL * 2);
    Append(s, seq, kMsgVideoH264, meta4,
           {0, 0, 0, 1, 0x67, 0x42, 0xE0, 0x28, 0, 0, 0, 1, 0x68, 0xCE, 0x3C, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x84});
    // type 4 delta frame, negative (unknown) time
    BuildH264Meta(meta4.data(), false, 1920, 1080, -1);
    Append(s, seq, kMsgVideoH264, meta4, {0, 0, 0, 1, 0x41, 0x9A, 0x22});

    // type 5: 960 stereo frames, ramp
    std::vector<uint8_t> meta5(kAudioMetaSize), pcm(960 * 2 * 2);
    for (size_t i = 0; i < 960; ++i) {
        const int16_t l = static_cast<int16_t>(i), r = static_cast<int16_t>(-static_cast<int>(i));
        pcm[4 * i] = static_cast<uint8_t>(l);
        pcm[4 * i + 1] = static_cast<uint8_t>(l >> 8);
        pcm[4 * i + 2] = static_cast<uint8_t>(r);
        pcm[4 * i + 3] = static_cast<uint8_t>(r >> 8);
    }
    BuildAudioMeta(meta5.data(), 48000, 2, 960, 254016000000LL * 7 + 5292000);
    Append(s, seq, kMsgAudioPcm, meta5, pcm);

    FILE* f = std::fopen(path, "wb");
    if (!f) {
        std::printf("cannot write %s\n", path);
        ++g_fail;
        return;
    }
    std::fwrite(s.data(), 1, s.size(), f);
    std::fclose(f);
}

int main(int argc, char** argv) {
    TestIncoming();
    WriteGolden(argc > 1 ? argv[1] : "golden.bin");
    if (g_fail) {
        std::printf("test_otx: %d failure(s)\n", g_fail);
        return 1;
    }
    std::printf("test_otx: ok\n");
    return 0;
}
