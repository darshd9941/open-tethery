// Pocket Monitor — native Transmit plugin
// Push-audio helpers: float planar -> int16 interleaved stereo, and a
// lock-protected queue that decouples Premiere's PushAudio thread from the
// sender thread. Pure C++ (no Windows headers) so it is unit-tested on Linux.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <vector>

namespace otx {

constexpr uint32_t kAudioRate = 48000;
constexpr int64_t kProtocolTicksPerSecond = 254016000000LL;
constexpr int64_t kTicksPerAudioFrame = kProtocolTicksPerSecond / kAudioRate;  // 5292000, exact

inline int16_t FloatToInt16(float v) {
    if (!(v == v)) return 0;  // NaN
    v = std::max(-1.0f, std::min(1.0f, v));
    const float s = v * 32767.0f;
    return static_cast<int16_t>(s < 0 ? s - 0.5f : s + 0.5f);
}

// Converts planar float channels to interleaved int16 stereo (appends to out).
//   1 channel  -> both sides
//   2 channels -> as is
//   >2         -> fold-down assuming the usual order L R C LFE Ls Rs (Lb Rb):
//                 C, Ls/Rs and extra channels at -3 dB to their side, LFE dropped,
//                 everything scaled by 1/(1+2*0.707) so a full-scale mix cannot clip.
inline void InterleaveStereoInt16(const float* const* in, uint32_t channels, uint32_t frames,
                                  std::vector<int16_t>& out) {
    const size_t base = out.size();
    out.resize(base + static_cast<size_t>(frames) * 2);
    int16_t* o = out.data() + base;
    if (!in || channels == 0) {
        std::fill(o, o + static_cast<size_t>(frames) * 2, int16_t(0));
        return;
    }
    if (channels == 1) {
        for (uint32_t i = 0; i < frames; ++i) o[2 * i] = o[2 * i + 1] = FloatToInt16(in[0][i]);
    } else if (channels == 2) {
        for (uint32_t i = 0; i < frames; ++i) {
            o[2 * i] = FloatToInt16(in[0][i]);
            o[2 * i + 1] = FloatToInt16(in[1][i]);
        }
    } else {
        const float k = 0.7071068f;
        const float norm = 1.0f / (1.0f + k + k);
        auto ch = [&](uint32_t c, uint32_t i) { return c < channels ? in[c][i] : 0.0f; };
        for (uint32_t i = 0; i < frames; ++i) {
            const float c = ch(2, i);
            const float l = in[0][i] + k * c + k * ch(4, i) + k * ch(6, i);
            const float r = in[1][i] + k * c + k * ch(5, i) + k * ch(7, i);
            o[2 * i] = FloatToInt16(l * norm);
            o[2 * i + 1] = FloatToInt16(r * norm);
        }
    }
}

// Time-stamped PCM queue. Producer: Premiere's PushAudio thread. Consumer: the
// sender thread. Samples are int16 interleaved stereo at 48 kHz. A new
// segment starts whenever the incoming time is not contiguous with the
// previous one (seek, loop), so a chunk never spans a jump. When the queue
// holds more than maxFrames the oldest samples are dropped.
class AudioQueue {
public:
    explicit AudioQueue(size_t maxFrames = kAudioRate) : maxFrames_(maxFrames) {}

    // ticks: protocol ticks of the first sample, or -1 if unknown.
    void Push(const int16_t* stereo, size_t frames, int64_t ticks) {
        if (!frames) return;
        std::lock_guard<std::mutex> lock(m_);
        bool contiguous = false;
        if (!segs_.empty()) {
            const Segment& last = segs_.back();
            if (last.ticks < 0 && ticks < 0) {
                contiguous = true;
            } else if (last.ticks >= 0 && ticks >= 0) {
                const int64_t expect = last.ticks + static_cast<int64_t>(last.frames()) * kTicksPerAudioFrame;
                contiguous = std::llabs(ticks - expect) <= kTicksPerAudioFrame * 48;  // 1 ms
            }
        }
        if (!contiguous) {
            segs_.emplace_back();
            segs_.back().ticks = ticks;
        }
        Segment& s = segs_.back();
        s.samples.insert(s.samples.end(), stereo, stereo + frames * 2);
        total_ += frames;
        while (total_ > maxFrames_ && !segs_.empty()) {
            Segment& f = segs_.front();
            const size_t drop = std::min(total_ - maxFrames_, f.frames());
            f.samples.erase(f.samples.begin(), f.samples.begin() + static_cast<ptrdiff_t>(drop * 2));
            if (f.ticks >= 0) f.ticks += static_cast<int64_t>(drop) * kTicksPerAudioFrame;
            total_ -= drop;
            dropped_ += drop;
            if (f.samples.empty()) segs_.pop_front();
        }
    }

    // Pops up to maxChunk frames from the oldest segment into out. A full chunk
    // is returned whenever available; a shorter one only if flushPartial is set
    // or a later segment already exists (so the tail of a segment is not stuck).
    bool Pop(size_t maxChunk, bool flushPartial, std::vector<int16_t>& out, int64_t& ticks) {
        std::lock_guard<std::mutex> lock(m_);
        if (segs_.empty()) return false;
        Segment& f = segs_.front();
        const size_t have = f.frames();
        if (have < maxChunk && !flushPartial && segs_.size() == 1) return false;
        const size_t n = std::min(have, maxChunk);
        if (n == 0) {
            segs_.pop_front();
            return false;
        }
        out.assign(f.samples.begin(), f.samples.begin() + static_cast<ptrdiff_t>(n * 2));
        ticks = f.ticks;
        f.samples.erase(f.samples.begin(), f.samples.begin() + static_cast<ptrdiff_t>(n * 2));
        if (f.ticks >= 0) f.ticks += static_cast<int64_t>(n) * kTicksPerAudioFrame;
        total_ -= n;
        if (f.samples.empty()) segs_.pop_front();
        return true;
    }

    void Clear() {
        std::lock_guard<std::mutex> lock(m_);
        segs_.clear();
        total_ = 0;
    }
    size_t Frames() const {
        std::lock_guard<std::mutex> lock(m_);
        return total_;
    }
    size_t Dropped() const {
        std::lock_guard<std::mutex> lock(m_);
        return dropped_;
    }

private:
    struct Segment {
        int64_t ticks = -1;
        std::vector<int16_t> samples;
        size_t frames() const { return samples.size() / 2; }
    };
    mutable std::mutex m_;
    std::deque<Segment> segs_;
    size_t total_ = 0;
    size_t maxFrames_;
    size_t dropped_ = 0;
};

} // namespace otx
