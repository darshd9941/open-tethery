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

    // --- Tuning ------------------------------------------------------------
    static constexpr int kMaxFps = 15;
    static constexpr int kMaxEdge = 1280;
    static constexpr float kJpegQuality = 0.8f;

private:
    using Clock = std::chrono::steady_clock;

    void Run();

    std::thread worker_;
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
