// Pocket Monitor — native Transmit plugin
// OTX1 wire format helpers (see docs/transmit-protocol.md). Pure C++, no
// Windows headers, so the unit tests can build it with any compiler.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace otx {

enum MsgType : uint8_t {
    kMsgVideoJpeg = 1,
    kMsgState = 2,
    kMsgHeartbeat = 3,
    kMsgVideoH264 = 4,
    kMsgAudioPcm = 5,
    kMsgRequestKeyframe = 64,  // helper -> plugin
    kMsgJpegWanted = 65,       // helper -> plugin
};

constexpr size_t kHeaderSize = 16;
constexpr size_t kJpegMetaSize = 24;
constexpr size_t kH264MetaSize = 16;
constexpr size_t kAudioMetaSize = 16;
constexpr uint32_t kMaxPayload = 32u * 1024u * 1024u;

inline void PutU16(uint8_t* p, uint16_t v) {
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
}
inline void PutU32(uint8_t* p, uint32_t v) {
    for (int i = 0; i < 4; ++i) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
inline void PutU64(uint8_t* p, uint64_t v) {
    for (int i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>(v >> (8 * i));
}
inline uint16_t Clamp16(int v) { return static_cast<uint16_t>(std::max(0, std::min(v, 65535))); }

// Writes the 16-byte message header.
inline void BuildHeader(uint8_t* h, uint8_t type, uint32_t payloadLen, uint32_t seq) {
    std::memcpy(h, "OTXF", 4);
    h[4] = type;
    h[5] = h[6] = h[7] = 0;
    PutU32(h + 8, payloadLen);
    PutU32(h + 12, seq);
}

// Type 1 meta (24 bytes).
inline void BuildJpegMeta(uint8_t* m, int w, int h, int seqW, int seqH, int64_t ticks, uint32_t fpsNum,
                          uint32_t fpsDen) {
    PutU16(m + 0, Clamp16(w));
    PutU16(m + 2, Clamp16(h));
    PutU16(m + 4, Clamp16(seqW));
    PutU16(m + 6, Clamp16(seqH));
    PutU64(m + 8, static_cast<uint64_t>(ticks));
    PutU32(m + 16, fpsNum);
    PutU32(m + 20, fpsNum ? fpsDen : 0);
}

// Type 4 meta (16 bytes).
inline void BuildH264Meta(uint8_t* m, bool keyframe, int w, int h, int64_t ticks) {
    std::memset(m, 0, kH264MetaSize);
    m[0] = keyframe ? 1 : 0;
    PutU16(m + 4, Clamp16(w));
    PutU16(m + 6, Clamp16(h));
    PutU64(m + 8, static_cast<uint64_t>(ticks));
}

// Type 5 meta (16 bytes): int16 interleaved PCM follows.
inline void BuildAudioMeta(uint8_t* m, uint32_t sampleRate, uint8_t channels, uint16_t frames, int64_t ticks) {
    std::memset(m, 0, kAudioMetaSize);
    PutU32(m + 0, sampleRate);
    m[4] = channels;
    m[5] = 1;  // int16 interleaved
    PutU16(m + 6, frames);
    PutU64(m + 8, static_cast<uint64_t>(ticks));
}

// Reader for helper -> plugin messages. Feed() takes whatever recv() gave and
// calls onMessage(type, payload, len) per complete message. Payloads above
// maxPayload are skipped without buffering. Returns false on bad magic (the
// caller closes the connection).
class IncomingParser {
public:
    explicit IncomingParser(size_t maxPayload = 4096) : maxPayload_(maxPayload) {}

    template <class F>
    bool Feed(const uint8_t* data, size_t len, F onMessage) {
        size_t pos = 0;
        while (pos < len) {
            if (skip_ > 0) {
                const size_t n = std::min(skip_, len - pos);
                skip_ -= n;
                pos += n;
                continue;
            }
            if (!inPayload_) {
                const size_t n = std::min(kHeaderSize - head_.size(), len - pos);
                head_.insert(head_.end(), data + pos, data + pos + n);
                pos += n;
                for (size_t i = 0; i < std::min<size_t>(head_.size(), 4); ++i)
                    if (head_[i] != static_cast<uint8_t>("OTXF"[i])) return false;
                if (head_.size() < kHeaderSize) continue;
                type_ = head_[4];
                const uint32_t plen = static_cast<uint32_t>(head_[8]) | (static_cast<uint32_t>(head_[9]) << 8) |
                                      (static_cast<uint32_t>(head_[10]) << 16) |
                                      (static_cast<uint32_t>(head_[11]) << 24);
                head_.clear();
                if (plen > maxPayload_) {
                    skip_ = plen;
                    continue;
                }
                need_ = plen;
                payload_.clear();
                if (need_ == 0) {
                    onMessage(type_, static_cast<const uint8_t*>(nullptr), static_cast<size_t>(0));
                    continue;
                }
                inPayload_ = true;
            } else {
                const size_t n = std::min(need_ - payload_.size(), len - pos);
                payload_.insert(payload_.end(), data + pos, data + pos + n);
                pos += n;
                if (payload_.size() == need_) {
                    inPayload_ = false;
                    onMessage(type_, static_cast<const uint8_t*>(payload_.data()), payload_.size());
                    payload_.clear();
                }
            }
        }
        return true;
    }

private:
    size_t maxPayload_;
    std::vector<uint8_t> head_;
    std::vector<uint8_t> payload_;
    bool inPayload_ = false;
    size_t need_ = 0;
    size_t skip_ = 0;
    uint8_t type_ = 0;
};

// Parses {"jpeg":true|false}. Returns false if the payload has no jpeg flag.
inline bool ParseJpegWanted(const uint8_t* p, size_t n, bool& wanted) {
    static const char key[] = "\"jpeg\"";
    const size_t kl = sizeof(key) - 1;
    for (size_t i = 0; i + kl <= n; ++i) {
        if (std::memcmp(p + i, key, kl) != 0) continue;
        size_t j = i + kl;
        while (j < n && (p[j] == ' ' || p[j] == ':' || p[j] == '\t')) ++j;
        if (j + 4 <= n && std::memcmp(p + j, "true", 4) == 0) {
            wanted = true;
            return true;
        }
        if (j + 5 <= n && std::memcmp(p + j, "false", 5) == 0) {
            wanted = false;
            return true;
        }
        return false;
    }
    return false;
}

} // namespace otx
