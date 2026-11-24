// Pocket Monitor — native Transmit plugin
// Worker thread: downscale, JPEG-encode and send frames over loopback TCP.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <objbase.h>

#include "FrameSender.h"
#include "AnnexB.h"
#include "H264Encoder.h"
#include "ImageOps.h"
#include "JpegEncoder.h"
#include "Otx1.h"
#include "Log.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <utility>

namespace otx {

namespace {

constexpr uint16_t kRelayPort = 47826;
constexpr const char* kPluginVersion = "0.1.0";
constexpr auto kReconnectInterval = std::chrono::seconds(2);
constexpr auto kHeartbeatInterval = std::chrono::seconds(1);
constexpr auto kPlayingTimeout = std::chrono::milliseconds(1000);
constexpr auto kIdlePoll = std::chrono::milliseconds(50);
constexpr DWORD kSendTimeoutMs = 1000;
constexpr int kConnectTimeoutMs = 500;

// --- Loopback TCP connection -----------------------------------------------

class Connection {
public:
    ~Connection() { Close(); }

    bool IsOpen() const { return sock_ != INVALID_SOCKET; }

    bool Open() {
        Close();
        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s == INVALID_SOCKET) return false;

        u_long nonBlocking = 1;
        ioctlsocket(s, FIONBIO, &nonBlocking);

        sockaddr_in addr = {};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(kRelayPort);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

        int rc = connect(s, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
        if (rc == SOCKET_ERROR && WSAGetLastError() != WSAEWOULDBLOCK) {
            closesocket(s);
            return false;
        }
        if (rc == SOCKET_ERROR) {
            fd_set wr, ex;
            FD_ZERO(&wr);
            FD_ZERO(&ex);
            FD_SET(s, &wr);
            FD_SET(s, &ex);
            timeval tv = {0, kConnectTimeoutMs * 1000};
            if (select(0, nullptr, &wr, &ex, &tv) <= 0 || FD_ISSET(s, &ex) || !FD_ISSET(s, &wr)) {
                closesocket(s);
                return false;
            }
            int err = 0;
            int len = sizeof(err);
            getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&err), &len);
            if (err != 0) {
                closesocket(s);
                return false;
            }
        }

        // Back to blocking with a send timeout: the worker may wait, Premiere never does.
        nonBlocking = 0;
        ioctlsocket(s, FIONBIO, &nonBlocking);
        DWORD timeout = kSendTimeoutMs;
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        BOOL noDelay = TRUE;
        setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&noDelay), sizeof(noDelay));
        int sndBuf = 1 << 20;
        setsockopt(s, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&sndBuf), sizeof(sndBuf));

        sock_ = s;
        seq_ = 0;
        parser_ = IncomingParser();
        return true;
    }

    void Close() {
        if (sock_ != INVALID_SOCKET) {
            shutdown(sock_, SD_BOTH);
            closesocket(sock_);
            sock_ = INVALID_SOCKET;
        }
    }

    // Reads whatever the relay sent (helper -> plugin messages, types 64/65),
    // without blocking, and calls onMessage(type, payload, len) for each.
    // Returns false when the relay hung up or sent garbage.
    template <class F>
    bool Pump(F onMessage) {
        if (!IsOpen()) return false;
        for (int round = 0; round < 64; ++round) {
            fd_set rd;
            FD_ZERO(&rd);
            FD_SET(sock_, &rd);
            timeval tv = {0, 0};
            const int r = select(0, &rd, nullptr, nullptr, &tv);
            if (r == 0) return true;
            if (r < 0) return false;
            uint8_t buf[1024];
            const int n = recv(sock_, reinterpret_cast<char*>(buf), sizeof(buf), 0);
            if (n <= 0) return false;
            if (!parser_.Feed(buf, static_cast<size_t>(n), onMessage)) return false;
        }
        return true;
    }

    // Sends one OTX1 message (header + up to two payload parts).
    bool Send(uint8_t type, const uint8_t* a, size_t aLen, const uint8_t* b = nullptr, size_t bLen = 0) {
        if (!IsOpen()) return false;
        const size_t payload = aLen + bLen;
        if (payload > kMaxPayload) return false;

        buffer_.resize(16 + payload);
        uint8_t* h = buffer_.data();
        BuildHeader(h, type, static_cast<uint32_t>(payload), seq_++);
        if (aLen) std::memcpy(h + 16, a, aLen);
        if (bLen) std::memcpy(h + 16 + aLen, b, bLen);

        const char* p = reinterpret_cast<const char*>(buffer_.data());
        size_t left = buffer_.size();
        while (left > 0) {
            int chunk = static_cast<int>(std::min<size_t>(left, 1 << 20));
            int n = send(sock_, p, chunk, 0);
            if (n <= 0) {
                Close();
                return false;
            }
            p += n;
            left -= static_cast<size_t>(n);
        }
        return true;
    }

private:
    SOCKET sock_ = INVALID_SOCKET;
    uint32_t seq_ = 0;
    std::vector<uint8_t> buffer_;
    IncomingParser parser_;
};

// --- Image scaling -----------------------------------------------------------

// Box-filter downscale (or plain copy when no scaling is needed) from top-down
// BGRA to top-down BGR. Each output pixel averages the source rectangle it
// covers, so large reductions do not alias.
void ScaleBgraToBgr(const RawFrame& src, int outW, int outH, std::vector<uint8_t>& dst, int& dstStride) {
    dstStride = (outW * 3 + 3) & ~3;
    dst.resize(static_cast<size_t>(dstStride) * outH);
    const int sw = src.width;
    const int sh = src.height;
    const size_t srcStride = static_cast<size_t>(sw) * 4;
    const uint8_t* s = src.pixels.data();

    if (outW == sw && outH == sh) {
        for (int y = 0; y < sh; ++y) {
            const uint8_t* in = s + y * srcStride;
            uint8_t* out = dst.data() + static_cast<size_t>(y) * dstStride;
            for (int x = 0; x < sw; ++x) {
                out[0] = in[0];
                out[1] = in[1];
                out[2] = in[2];
                in += 4;
                out += 3;
            }
        }
        return;
    }

    std::vector<int> x0(outW), x1(outW);
    for (int x = 0; x < outW; ++x) {
        x0[x] = static_cast<int>(static_cast<int64_t>(x) * sw / outW);
        x1[x] = std::max(x0[x] + 1, static_cast<int>(static_cast<int64_t>(x + 1) * sw / outW));
    }
    std::vector<uint32_t> acc(static_cast<size_t>(outW) * 3);

    for (int y = 0; y < outH; ++y) {
        const int y0 = static_cast<int>(static_cast<int64_t>(y) * sh / outH);
        const int y1 = std::max(y0 + 1, static_cast<int>(static_cast<int64_t>(y + 1) * sh / outH));
        std::fill(acc.begin(), acc.end(), 0u);
        for (int sy = y0; sy < y1; ++sy) {
            const uint8_t* row = s + sy * srcStride;
            for (int x = 0; x < outW; ++x) {
                uint32_t b = 0, g = 0, r = 0;
                const uint8_t* px = row + static_cast<size_t>(x0[x]) * 4;
                for (int sx = x0[x]; sx < x1[x]; ++sx) {
                    b += px[0];
                    g += px[1];
                    r += px[2];
                    px += 4;
                }
                uint32_t* a = &acc[static_cast<size_t>(x) * 3];
                a[0] += b;
                a[1] += g;
                a[2] += r;
            }
        }
        uint8_t* out = dst.data() + static_cast<size_t>(y) * dstStride;
        const int rows = y1 - y0;
        for (int x = 0; x < outW; ++x) {
            const uint32_t n = static_cast<uint32_t>(rows * (x1[x] - x0[x]));
            const uint32_t* a = &acc[static_cast<size_t>(x) * 3];
            out[0] = static_cast<uint8_t>((a[0] + n / 2) / n);
            out[1] = static_cast<uint8_t>((a[1] + n / 2) / n);
            out[2] = static_cast<uint8_t>((a[2] + n / 2) / n);
            out += 3;
        }
    }
}

std::string StateJson(bool playing) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "{\"app\":\"premiere\",\"playing\":%s,\"pluginVersion\":\"%s\"}",
                  playing ? "true" : "false", kPluginVersion);
    return buf;
}

} // namespace

// --- FrameSender -------------------------------------------------------------

FrameSender::FrameSender() = default;

FrameSender::~FrameSender() { Stop(); }

void FrameSender::Start() {
    if (running_.exchange(true)) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stop_ = false;
        stateDirty_ = true;
    }
    try {
        worker_ = std::thread(&FrameSender::Run, this);
    } catch (...) {
        running_ = false;
        Log("could not start worker thread");
    }
}

void FrameSender::Stop() {
    if (!running_.exchange(false)) return;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stop_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
}

bool FrameSender::WantCapture(bool playing) {
    if (!running_) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (!playing) return true;
    const auto now = Clock::now();
    return now - lastCapture_ >= std::chrono::milliseconds(1000 / std::max(1, captureFps_.load()));
}

RawFrame& FrameSender::LockStaging() {
    stagingMutex_.lock();
    return staging_;
}

void FrameSender::AbandonStaging() { stagingMutex_.unlock(); }

void FrameSender::CommitStaging() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::swap(slot_, staging_);  // vectors swap buffers, no copy
        slotFull_ = true;
        lastCapture_ = Clock::now();
    }
    stagingMutex_.unlock();
    cv_.notify_one();
}

void FrameSender::SetPlaying(bool playing) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (playing) lastPlayingPush_ = Clock::now();
        if (playing_ == playing) return;
        playing_ = playing;
        stateDirty_ = true;
    }
    cv_.notify_one();
}

void FrameSender::SetAudioActive(bool active) {
    const bool was = audioActive_.exchange(active);
    if (was && !active) audioQueue_.Clear();
}

void FrameSender::PushAudio(const int16_t* stereo, size_t frames, int64_t ticks) {
    if (!running_ || !audioActive_ || !stereo || !frames) return;
    audioQueue_.Push(stereo, frames, ticks);
    lastAudioPushNs_ = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count();
    {
        // Take the lock so the notify cannot slip between the worker's predicate check and its wait.
        std::lock_guard<std::mutex> lock(mutex_);
    }
    cv_.notify_one();
}


void FrameSender::Run() {
    Log("worker started");
    const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    WSADATA wsa = {};
    const bool wsaOk = WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
    if (!wsaOk) Log("WSAStartup failed; frames will not be sent");

    JpegEncoder jpeg;
    if (!jpeg.Init()) Log("WIC JPEG encoder unavailable; frames will not be sent");

    // H.264 is optional: OPEN_TETHERY_H264=0 turns it off, =sw skips hardware encoders.
    char h264Env[8] = {};
    GetEnvironmentVariableA("OPEN_TETHERY_H264", h264Env, sizeof(h264Env));
    bool h264Allowed = std::strcmp(h264Env, "0") != 0;
    bool allowHardware = std::strcmp(h264Env, "sw") != 0;
    if (!h264Allowed) Log("H.264 disabled by OPEN_TETHERY_H264=0 (JPEG only)");

    Connection conn;
    RawFrame work;                 // frame being encoded (swapped out of the slot)
    std::vector<uint8_t> scaled;   // BGR after downscale (JPEG)
    std::vector<uint8_t> encoded;  // JPEG bytes
    auto nextConnect = Clock::now();
    auto lastSent = Clock::now();
    auto nextFrameAllowed = Clock::now();
    bool loggedDown = false;
    bool encodeErrorLogged = false;

    // --- H.264 state (worker thread only) ---
    H264Encoder h264;
    std::vector<uint8_t> scaledBgra, nv12, lastNv12;
    std::deque<std::pair<int64_t, int64_t>> pendingTicks;  // MF sample time -> playhead ticks
    int64_t lastTicks = -1;
    int lastW = 0, lastH = 0;
    bool haveLast = false;
    const auto t0 = Clock::now();
    auto lastKeyForced = t0;
    auto lastEncode = t0;
    auto lastAuSent = t0;
    auto nextJpegAllowed = t0;
    bool keyRequested = false;
    bool jpegWanted = true;  // helper default on every new connection
    int h264Failures = 0;
    bool h264Logged = false;
    constexpr auto kKeyInterval = std::chrono::milliseconds(1500);
    constexpr auto kRepeatInterval = std::chrono::milliseconds(700);  // >= 1 AU/s even when static
    constexpr auto kJpegInterval = std::chrono::milliseconds(200);     // ~5 fps next to H.264

    auto sampleTimeNow = [&]() -> int64_t {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - t0).count() / 100;
    };

    // Fatal encoder trouble: drop the encoder; retry once in software, then give up (JPEG only).
    auto h264Fail = [&](const char* why) {
        ++h264Failures;
        Log("H.264 failed (%s)%s", why, h264Failures >= 3 ? "; falling back to JPEG only" : "; retrying");
        if (h264.IsHardware()) allowHardware = false;
        h264.Shutdown();
        pendingTicks.clear();
        haveLast = false;
        if (h264Failures >= 3 || (!allowHardware && h264Failures >= 2)) h264Allowed = false;
        captureFps_ = kMaxFps;
    };

    // Converts the frame and submits it. Returns true if an encoder is running afterwards.
    auto encodeH264 = [&](const RawFrame& f) -> bool {
        int ew = 0, eh = 0;
        FitEven(f.width, f.height, 1920, 1080, ew, eh);
        if (!h264.IsOpen() || h264.Width() != ew || h264.Height() != eh) {
            h264.Shutdown();
            pendingTicks.clear();
            haveLast = false;
            if (!h264.Init(ew, eh, 30, H264Encoder::BitrateFor(ew, eh), allowHardware)) {
                h264Fail("init");
                return false;
            }
            lastKeyForced = Clock::now();
            h264Logged = false;
            captureFps_ = kMaxFpsH264;
        }
        const uint8_t* src = f.pixels.data();
        size_t stride = static_cast<size_t>(f.width) * 4;
        if (f.width > ew + 1 || f.height > eh + 1) {
            ScaleBgraBox(src, f.width, f.height, ew, eh, scaledBgra);
            src = scaledBgra.data();
            stride = static_cast<size_t>(ew) * 4;
        }  // else: at most one odd row/column is cropped
        nv12.resize(static_cast<size_t>(ew) * eh * 3 / 2);
        BgraToNv12(src, stride, ew, eh, nv12.data());

        const auto now = Clock::now();
        if (keyRequested || now - lastKeyForced >= kKeyInterval) {
            h264.RequestKeyframe();
            keyRequested = false;
            lastKeyForced = now;
        }
        const int64_t st = sampleTimeNow();
        bool accepted = false;
        if (!h264.Encode(nv12.data(), st, &accepted)) {
            h264Fail("encode");
            return false;
        }
        if (accepted) {
            pendingTicks.emplace_back(st, f.timeTicks);
            while (pendingTicks.size() > 256) pendingTicks.pop_front();
            std::swap(nv12, lastNv12);
            lastTicks = f.timeTicks;
            lastW = ew;
            lastH = eh;
            haveLast = true;
            lastEncode = now;
        }
        return true;
    };

    bool fastPoll = false;  // encoder has frames in flight: do not sleep long

    for (;;) {
        // 1. Connect (or reconnect every 2 s) outside the lock.
        if (wsaOk && !conn.IsOpen() && Clock::now() >= nextConnect) {
            if (conn.Open()) {
                Log("connected to relay on 127.0.0.1:47826");
                audioQueue_.Clear();  // never replay stale audio to a new connection
                loggedDown = false;
                jpegWanted = true;
                keyRequested = true;  // a fresh viewer must be able to start on an IDR
                std::lock_guard<std::mutex> lock(mutex_);
                stateDirty_ = true;  // state goes first on every new connection
            } else {
                if (!loggedDown) Log("relay not reachable; retrying every 2 s");
                loggedDown = true;
                nextConnect = Clock::now() + kReconnectInterval;
            }
        }
        if (conn.IsOpen()) {
            const bool alive = conn.Pump([&](uint8_t type, const uint8_t* p, size_t n) {
                if (type == kMsgRequestKeyframe) {
                    keyRequested = true;
                } else if (type == kMsgJpegWanted) {
                    bool w = true;
                    if (ParseJpegWanted(p, n, w)) {
                        if (w != jpegWanted) Log("helper: jpeg %s", w ? "wanted" : "not wanted");
                        jpegWanted = w;
                    }
                }  // other types are ignored
            });
            if (!alive) {
                Log("relay closed the connection");
                conn.Close();
                nextConnect = Clock::now() + kReconnectInterval;
            }
        }

        // 2. Wait for work.
        bool haveFrame = false;
        bool sendState = false;
        bool playing = false;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            const bool open = conn.IsOpen();
            auto now = Clock::now();
            auto wake = now + kIdlePoll;
            if (open && slotFull_ && nextFrameAllowed < wake) wake = nextFrameAllowed;
            const bool audioOn = audioActive_.load();
            if (audioOn && now + std::chrono::milliseconds(10) < wake) wake = now + std::chrono::milliseconds(10);
            if (fastPoll && now + std::chrono::milliseconds(4) < wake) wake = now + std::chrono::milliseconds(4);
            cv_.wait_until(lock, wake, [&] {
                return stop_ || (open && stateDirty_) ||
                       (open && slotFull_ && Clock::now() >= nextFrameAllowed) ||
                       (open && audioOn && audioQueue_.Frames() >= kAudioChunkFrames);
            });
            if (stop_) break;

            now = Clock::now();
            // No pushes for a while during "playing": Premiere stopped without
            // telling us (we are not the clock device), so report paused.
            if (playing_ && now - lastPlayingPush_ > kPlayingTimeout) {
                playing_ = false;
                stateDirty_ = true;
            }
            if (open) {
                if (stateDirty_) {
                    sendState = true;
                    stateDirty_ = false;
                }
                // While disconnected the newest frame stays in the slot, so it
                // is the first thing a freshly connected relay gets.
                if (slotFull_ && now >= nextFrameAllowed) {
                    std::swap(work, slot_);
                    slotFull_ = false;
                    haveFrame = true;
                }
            }
            playing = playing_;
        }

        if (!conn.IsOpen()) {
            // Nothing to send to: keep the encoder from piling up output.
            if (h264.IsOpen()) {
                h264.Poll();
                EncodedAu drop;
                while (h264.PopOutput(drop)) {
                }
            }
            continue;
        }

        // 3. Send.
        if (sendState) {
            const std::string json = StateJson(playing);
            if (conn.Send(kMsgState, reinterpret_cast<const uint8_t*>(json.data()), json.size()))
                lastSent = Clock::now();
        }

        const bool frameUsable = haveFrame && work.width > 0 && work.height > 0 &&
                                 work.pixels.size() >= static_cast<size_t>(work.width) * work.height * 4;
        bool encodedThisRound = false;
        if (frameUsable) {
            nextFrameAllowed = Clock::now() + std::chrono::milliseconds(1000 / std::max(1, captureFps_.load()));

            // H.264 first (it is the main stream when it works).
            if (h264Allowed) {
                encodedThisRound = true;
                if (!encodeH264(work)) encodedThisRound = false;
            }

            // JPEG: every frame when there is no H.264, otherwise only when the
            // helper asks for it (type 65), at ~5 fps. If H.264 output has not
            // been flowing for 2 s the phones would see nothing, so send JPEG anyway.
            const auto now = Clock::now();
            const bool h264Flowing = h264.IsOpen() && h264.Produced() > 0 && now - lastAuSent < std::chrono::seconds(2);
            const bool wantJpeg = !h264Allowed || !h264.IsOpen() ||
                                  ((jpegWanted || !h264Flowing) && now >= nextJpegAllowed);
            if (wantJpeg) {
                if (h264.IsOpen()) nextJpegAllowed = now + kJpegInterval;
                int outW = work.width;
                int outH = work.height;
                const int longest = std::max(outW, outH);
                if (longest > kMaxEdge) {
                    outW = std::max(1, static_cast<int>((static_cast<int64_t>(work.width) * kMaxEdge + longest / 2) / longest));
                    outH = std::max(1, static_cast<int>((static_cast<int64_t>(work.height) * kMaxEdge + longest / 2) / longest));
                }
                int stride = 0;
                ScaleBgraToBgr(work, outW, outH, scaled, stride);
                if (jpeg.Encode(scaled.data(), outW, outH, stride, kJpegQuality, encoded)) {
                    uint8_t meta[kJpegMetaSize];
                    BuildJpegMeta(meta, outW, outH, work.seqWidth > 0 ? work.seqWidth : work.width,
                                  work.seqHeight > 0 ? work.seqHeight : work.height, work.timeTicks, work.fpsNum,
                                  work.fpsDen);
                    if (conn.Send(kMsgVideoJpeg, meta, sizeof(meta), encoded.data(), encoded.size()))
                        lastSent = Clock::now();
                } else if (!encodeErrorLogged) {
                    Log("JPEG encode failed (further failures not logged)");
                    encodeErrorLogged = true;
                }
            }
        }

        // H.264 housekeeping: static picture -> re-encode the last frame so the
        // stream never goes quiet; then collect and send finished access units.
        if (h264.IsOpen() && conn.IsOpen()) {
            const auto now = Clock::now();
            if (!encodedThisRound && haveLast && now - lastEncode >= kRepeatInterval) {
                const int64_t st = sampleTimeNow();
                if (now - lastKeyForced >= kKeyInterval || keyRequested) {
                    h264.RequestKeyframe();
                    keyRequested = false;
                    lastKeyForced = now;
                }
                bool accepted = false;
                if (!h264.Encode(lastNv12.data(), st, &accepted)) {
                    h264Fail("repeat");
                } else if (accepted) {
                    pendingTicks.emplace_back(st, lastTicks);
                    lastEncode = now;
                }
            }
            if (h264.IsOpen()) {
                if (!h264.Poll()) {
                    h264Fail("poll");
                } else {
                    // Watchdog: an encoder that swallows frames without ever producing output is useless.
                    if (h264.Submitted() >= 30 && h264.Produced() == 0) h264Fail("no output");
                }
            }
            EncodedAu au;
            while (h264.IsOpen() && h264.PopOutput(au)) {
                int64_t ticks = lastTicks;
                while (!pendingTicks.empty() && pendingTicks.front().first <= au.sampleTime100ns) {
                    ticks = pendingTicks.front().second;
                    pendingTicks.pop_front();
                }
                uint8_t meta[kH264MetaSize];
                BuildH264Meta(meta, au.keyframe, h264.Width(), h264.Height(), ticks);
                if (!conn.Send(kMsgVideoH264, meta, sizeof(meta), au.data.data(), au.data.size())) break;
                lastSent = lastAuSent = Clock::now();
                if (!h264Logged) {
                    Log("first H.264 access unit sent (%zu bytes, %s)", au.data.size(), au.keyframe ? "IDR" : "delta");
                    h264Logged = true;
                }
            }
            fastPoll = h264.IsOpen() && h264.Submitted() > h264.Produced();
        } else {
            fastPoll = false;
        }

        // Audio: drain the queue in 20 ms chunks. A short tail is flushed once
        // the producer has been quiet for 25 ms.
        if (conn.IsOpen()) {
            int sentChunks = 0;
            std::vector<int16_t> pcm;
            int64_t pcmTicks = -1;
            const int64_t nowNs =
                std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count();
            const bool quiet = nowNs - lastAudioPushNs_.load() > 25000000;
            while (sentChunks < 16 && audioQueue_.Pop(kAudioChunkFrames, quiet, pcm, pcmTicks)) {
                uint8_t meta[kAudioMetaSize];
                BuildAudioMeta(meta, kAudioRate, 2, static_cast<uint16_t>(pcm.size() / 2), pcmTicks);
                if (!conn.Send(kMsgAudioPcm, meta, sizeof(meta), reinterpret_cast<const uint8_t*>(pcm.data()),
                               pcm.size() * sizeof(int16_t)))
                    break;
                lastSent = Clock::now();
                ++sentChunks;
            }
        }

        if (conn.IsOpen() && Clock::now() - lastSent >= kHeartbeatInterval) {
            if (conn.Send(kMsgHeartbeat, nullptr, 0)) lastSent = Clock::now();
        }
        if (!conn.IsOpen()) {
            Log("send failed; will reconnect");
            nextConnect = Clock::now() + kReconnectInterval;
        }
    }

    conn.Close();
    h264.Shutdown();
    jpeg.Release();
    if (wsaOk) WSACleanup();
    if (SUCCEEDED(coHr)) CoUninitialize();
    Log("worker stopped");
}

} // namespace otx
