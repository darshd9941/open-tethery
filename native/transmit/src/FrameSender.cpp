// Open Tethery — native Transmit plugin
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
#include "JpegEncoder.h"
#include "Otx1.h"
#include "Log.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>

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
        return true;
    }

    void Close() {
        if (sock_ != INVALID_SOCKET) {
            shutdown(sock_, SD_BOTH);
            closesocket(sock_);
            sock_ = INVALID_SOCKET;
        }
    }

    // Detects a relay that hung up (readable + recv == 0 or error). Any bytes
    // the relay sends are ignored.
    bool PeerClosed() {
        if (!IsOpen()) return true;
        for (;;) {
            fd_set rd;
            FD_ZERO(&rd);
            FD_SET(sock_, &rd);
            timeval tv = {0, 0};
            int r = select(0, &rd, nullptr, nullptr, &tv);
            if (r == 0) return false;
            if (r < 0) return true;
            char buf[256];
            int n = recv(sock_, buf, sizeof(buf), 0);
            if (n <= 0) return true;
        }
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
    return now - lastCapture_ >= std::chrono::milliseconds(1000 / kMaxFps);
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

    Connection conn;
    RawFrame work;                 // frame being encoded (swapped out of the slot)
    std::vector<uint8_t> scaled;   // BGR after downscale
    std::vector<uint8_t> encoded;  // JPEG bytes
    auto nextConnect = Clock::now();
    auto lastSent = Clock::now();
    auto nextFrameAllowed = Clock::now();
    const auto frameInterval = std::chrono::milliseconds(1000 / kMaxFps);
    bool loggedDown = false;
    bool encodeErrorLogged = false;

    for (;;) {
        // 1. Connect (or reconnect every 2 s) outside the lock.
        if (wsaOk && !conn.IsOpen() && Clock::now() >= nextConnect) {
            if (conn.Open()) {
                Log("connected to relay on 127.0.0.1:47826");
                audioQueue_.Clear();  // never replay stale audio to a new connection
                loggedDown = false;
                std::lock_guard<std::mutex> lock(mutex_);
                stateDirty_ = true;  // state goes first on every new connection
            } else {
                if (!loggedDown) Log("relay not reachable; retrying every 2 s");
                loggedDown = true;
                nextConnect = Clock::now() + kReconnectInterval;
            }
        }
        if (conn.IsOpen() && conn.PeerClosed()) {
            Log("relay closed the connection");
            conn.Close();
            nextConnect = Clock::now() + kReconnectInterval;
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

        if (!conn.IsOpen()) continue;

        // 3. Send.
        if (sendState) {
            const std::string json = StateJson(playing);
            if (conn.Send(kMsgState, reinterpret_cast<const uint8_t*>(json.data()), json.size()))
                lastSent = Clock::now();
        }

        if (haveFrame && work.width > 0 && work.height > 0 &&
            work.pixels.size() >= static_cast<size_t>(work.width) * work.height * 4) {
            nextFrameAllowed = Clock::now() + frameInterval;
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

        // Audio: drain the queue in 20 ms chunks. A short tail is flushed once
        // the producer has been quiet for 25 ms. Nothing is kept while disconnected.
        if (!conn.IsOpen()) {
            audioQueue_.Clear();
        } else {
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
    jpeg.Release();
    if (wsaOk) WSACleanup();
    if (SUCCEEDED(coHr)) CoUninitialize();
    Log("worker stopped");
}

} // namespace otx
