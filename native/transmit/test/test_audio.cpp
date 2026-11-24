// Unit tests for the pure audio parts (AudioPush.h). Host compiler, no Windows.
#include <cmath>
#include <cstdio>
#include <thread>

#include "../src/AudioPush.h"

static int g_fail = 0;
#define CHECK(c)                                                       \
    do {                                                               \
        if (!(c)) {                                                    \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c);   \
            ++g_fail;                                                  \
        }                                                              \
    } while (0)

using namespace otx;

static void TestConvert() {
    CHECK(FloatToInt16(0.0f) == 0);
    CHECK(FloatToInt16(1.0f) == 32767);
    CHECK(FloatToInt16(-1.0f) == -32767);
    CHECK(FloatToInt16(2.5f) == 32767);    // clamp
    CHECK(FloatToInt16(-9.0f) == -32767);  // clamp
    CHECK(FloatToInt16(NAN) == 0);
    CHECK(FloatToInt16(0.5f) == 16384);
    CHECK(FloatToInt16(-0.5f) == -16384);

    // stereo passthrough
    float l[4] = {0.0f, 0.5f, -0.5f, 1.0f}, r[4] = {1.0f, 0.0f, 0.25f, -1.0f};
    const float* st[2] = {l, r};
    std::vector<int16_t> out;
    InterleaveStereoInt16(st, 2, 4, out);
    CHECK(out.size() == 8);
    CHECK(out[0] == 0 && out[1] == 32767 && out[2] == 16384 && out[3] == 0 && out[7] == -32767);

    // mono -> both
    out.clear();
    const float* mo[1] = {l};
    InterleaveStereoInt16(mo, 1, 4, out);
    CHECK(out.size() == 8 && out[2] == out[3] && out[2] == 16384 && out[6] == out[7] && out[6] == 32767);

    // appends rather than replaces
    InterleaveStereoInt16(mo, 1, 1, out);
    CHECK(out.size() == 10);

    // 5.1: full-scale on every channel must not clip; LFE ignored
    float one[6][2];
    const float* sur[6];
    for (int c = 0; c < 6; ++c) {
        one[c][0] = one[c][1] = (c == 3) ? 0.0f : 1.0f;
        sur[c] = one[c];
    }
    out.clear();
    InterleaveStereoInt16(sur, 6, 2, out);
    CHECK(out[0] > 30000 && out[0] == out[1]);
    // only LFE -> silence
    float z[6][1] = {{0}, {0}, {0}, {1}, {0}, {0}};
    const float* lfe[6] = {z[0], z[1], z[2], z[3], z[4], z[5]};
    out.clear();
    InterleaveStereoInt16(lfe, 6, 1, out);
    CHECK(out[0] == 0 && out[1] == 0);
    // only centre -> equal, attenuated, both sides
    float zc[6][1] = {{0}, {0}, {1}, {0}, {0}, {0}};
    const float* cen[6] = {zc[0], zc[1], zc[2], zc[3], zc[4], zc[5]};
    out.clear();
    InterleaveStereoInt16(cen, 6, 1, out);
    CHECK(out[0] == out[1] && out[0] > 9000 && out[0] < 10000);
    // 3 channels (L R C) works, 16 channels does not crash
    out.clear();
    float big[16][3] = {};
    const float* bp[16];
    for (int c = 0; c < 16; ++c) bp[c] = big[c];
    InterleaveStereoInt16(bp, 16, 3, out);
    CHECK(out.size() == 6);
}

static std::vector<int16_t> Ramp(size_t frames, int16_t start) {
    std::vector<int16_t> v(frames * 2);
    for (size_t i = 0; i < frames; ++i) v[2 * i] = v[2 * i + 1] = static_cast<int16_t>(start + i);
    return v;
}

static void TestQueueChunking() {
    AudioQueue q(48000);
    int64_t t0 = 10 * kProtocolTicksPerSecond;
    // 1024-frame pushes (host buffer size), contiguous
    for (int i = 0; i < 4; ++i) {
        auto v = Ramp(1024, static_cast<int16_t>(i * 1024));
        q.Push(v.data(), 1024, t0 + i * 1024 * kTicksPerAudioFrame);
    }
    CHECK(q.Frames() == 4096);
    std::vector<int16_t> out;
    int64_t ticks = 0;
    size_t chunks = 0, frames = 0;
    int16_t expect = 0;
    while (q.Pop(960, false, out, ticks)) {
        CHECK(out.size() == 960 * 2);
        CHECK(ticks == t0 + static_cast<int64_t>(frames) * kTicksPerAudioFrame);
        CHECK(out[0] == expect);
        expect = static_cast<int16_t>(expect + 960);
        frames += 960;
        ++chunks;
    }
    CHECK(chunks == 4);           // 3840 frames
    CHECK(q.Frames() == 256);     // tail kept until flushed
    CHECK(q.Pop(960, true, out, ticks) && out.size() == 256 * 2);
    CHECK(ticks == t0 + 3840 * kTicksPerAudioFrame);
    CHECK(q.Frames() == 0);
    CHECK(!q.Pop(960, true, out, ticks));
}

static void TestQueueDiscontinuity() {
    AudioQueue q(48000);
    auto a = Ramp(500, 0), b = Ramp(500, 1000);
    q.Push(a.data(), 500, 1000 * kTicksPerAudioFrame);
    q.Push(b.data(), 500, 90000 * kTicksPerAudioFrame);  // seek
    std::vector<int16_t> out;
    int64_t ticks = 0;
    // the first segment's short tail is released because a later segment exists
    CHECK(q.Pop(960, false, out, ticks));
    CHECK(out.size() == 1000 && ticks == 1000 * kTicksPerAudioFrame && out[0] == 0);
    CHECK(!q.Pop(960, false, out, ticks));  // second segment is a partial tail now
    CHECK(q.Pop(960, true, out, ticks) && ticks == 90000 * kTicksPerAudioFrame && out[0] == 1000);
    // unknown times (-1) are contiguous with each other
    q.Push(a.data(), 100, -1);
    q.Push(a.data(), 100, -1);
    CHECK(q.Pop(960, true, out, ticks) && out.size() == 400 && ticks == -1);
}

static void TestQueueOverflow() {
    AudioQueue q(4800);  // 100 ms
    auto v = Ramp(1000, 0);
    int64_t t = 0;
    for (int i = 0; i < 10; ++i) {
        for (auto& s : v) s = 0;
        v[0] = v[1] = static_cast<int16_t>(i);  // marker
        q.Push(v.data(), 1000, t);
        t += 1000 * kTicksPerAudioFrame;
    }
    CHECK(q.Frames() == 4800);
    CHECK(q.Dropped() == 5200);
    std::vector<int16_t> out;
    int64_t ticks = 0;
    CHECK(q.Pop(960, false, out, ticks));
    // oldest were dropped: the head starts 5200 frames in, with its time advanced to match
    CHECK(ticks == 5200 * kTicksPerAudioFrame);
}

static void TestQueueThreads() {
    AudioQueue q(48000);
    std::thread prod([&] {
        auto v = Ramp(480, 0);
        for (int i = 0; i < 2000; ++i) q.Push(v.data(), 480, i * 480 * kTicksPerAudioFrame);
    });
    size_t got = 0;
    std::vector<int16_t> out;
    int64_t ticks;
    for (int spin = 0; spin < 2000000 && got < 1000; ++spin)
        if (q.Pop(960, true, out, ticks)) got += out.size() / 2;
    prod.join();
    while (q.Pop(960, true, out, ticks)) got += out.size() / 2;
    CHECK(got + q.Dropped() == 2000u * 480u);
}

int main() {
    TestConvert();
    TestQueueChunking();
    TestQueueDiscontinuity();
    TestQueueOverflow();
    TestQueueThreads();
    if (g_fail) {
        std::printf("test_audio: %d failure(s)\n", g_fail);
        return 1;
    }
    std::printf("test_audio: ok\n");
    return 0;
}
