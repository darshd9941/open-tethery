// Open Tethery — native Transmit plugin
// FrameSender: owns the "latest frame" slot and the worker thread that
// downscales, JPEG-encodes and sends frames to the local relay (OTX1 protocol,
// see docs/transmit-protocol.md).
//
// Threading: Premiere's thread only calls Submit*/SetPlaying/MarkIdle, which
// take a short mutex and never touch the network. Everything slow happens on
// the worker thread.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

#include "AudioPush.h"

namespace otx {

// A full-size, top-down BGRA 8-bit copy of one Premiere frame plus metadata.
struct RawFrame {
    std::vector<uint8_t> pixels;  // width * height * 4 bytes, top row first
    int width = 0;
    int height = 0;
    int seqWidth = 0;   // sequence frame size (before any downscale)
    int seqHeight = 0;
    int64_t timeTicks = -1;  // playhead in protocol ticks (254016000000 / s), -1 unknown
    uint32_t fpsNum = 0;
    uint32_t fpsDen = 1;
};

class FrameSender {
public:
    FrameSender();
    ~FrameSender();

    FrameSender(const FrameSender&) = delete;
    FrameSender& operator=(const FrameSender&) = delete;

    void Start();
    void Stop();  // idempotent; joins the worker (bounded by socket timeouts)

    // --- Called from Premiere's thread -------------------------------------

    // True if a frame pushed now should be captured. While playing, captures
    // are capped at kMaxFps; when stopped/scrubbing every frame is taken so the
    // newest one always wins.
    bool WantCapture(bool playing);

    // Exclusive access to the staging buffer that the caller fills, then
    // CommitStaging() publishes it into the latest-frame slot (newest wins).
    RawFrame& LockStaging();
    void CommitStaging();
    void AbandonStaging();

    void SetPlaying(bool playing);

    // Push audio (Premiere's audio thread, possibly concurrent with the calls
    // above): int16 interleaved stereo @ 48 kHz. Copies into a queue and
    // returns; the worker sends it. ticks = protocol ticks of the first sample
    // or -1. Ignored unless SetAudioActive(true).
    void SetAudioActive(bool active);
    void PushAudio(const int16_t* stereo, size_t frames, int64_t ticks);

    // --- Tuning ------------------------------------------------------------
    static constexpr int kMaxFps = 15;       // capture cap while playing, JPEG-only mode
    static constexpr int kMaxFpsH264 = 30;   // capture cap while playing, H.264 active
    static constexpr int kMaxEdge = 1280;
    static constexpr float kJpegQuality = 0.8f;
    static constexpr size_t kAudioChunkFrames = 960;  // 20 ms @ 48 kHz

private:
    using Clock = std::chrono::steady_clock;

    void Run();

    std::thread worker_;
    AudioQueue audioQueue_{kAudioRate};  // 1 s; oldest dropped on overflow
    std::atomic<int> captureFps_{kMaxFps};
    std::atomic<bool> audioActive_{false};
    std::atomic<int64_t> lastAudioPushNs_{0};
    std::atomic<bool> running_{false};

    // Staging buffer: owned by the producer (Premiere thread) between
    // LockStaging and CommitStaging.
    std::mutex stagingMutex_;
    RawFrame staging_;

    // Shared state, guarded by mutex_.
    std::mutex mutex_;
    std::condition_variable cv_;
    bool stop_ = false;
    RawFrame slot_;
    bool slotFull_ = false;
    bool playing_ = false;
    bool stateDirty_ = true;
    Clock::time_point lastPlayingPush_{};
    Clock::time_point lastCapture_{};
};

} // namespace otx
