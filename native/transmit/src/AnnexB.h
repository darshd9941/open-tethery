// Open Tethery — native Transmit plugin
// Annex B helpers: split NAL units, find SPS/PPS/IDR, and make sure every
// keyframe access unit starts with SPS + PPS. Pure C++, unit-tested.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace otx {

enum NalType : uint8_t { kNalSlice = 1, kNalIdr = 5, kNalSei = 6, kNalSps = 7, kNalPps = 8, kNalAud = 9 };

struct NalUnit {
    size_t start;      // offset of the start code
    size_t payload;    // offset of the NAL header byte (after the start code)
    size_t end;        // one past the last byte (trailing zero bytes of the next start code excluded)
    uint8_t type;      // nal_unit_type
};

// Finds NAL units delimited by 00 00 01 / 00 00 00 01 start codes.
inline std::vector<NalUnit> SplitAnnexB(const uint8_t* d, size_t n) {
    std::vector<NalUnit> out;
    size_t i = 0;
    long cur = -1;
    while (i + 3 <= n) {
        if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
            size_t sc = (i > 0 && d[i - 1] == 0) ? i - 1 : i;
            if (cur >= 0) {
                // trim the zero byte that belongs to a 4-byte start code (sc already accounts for one)
                out[static_cast<size_t>(cur)].end = sc;
            }
            if (i + 3 < n) {
                NalUnit u;
                u.start = sc;
                u.payload = i + 3;
                u.end = n;
                u.type = d[i + 3] & 0x1F;
                out.push_back(u);
                cur = static_cast<long>(out.size()) - 1;
            }
            i += 3;
        } else {
            ++i;
        }
    }
    return out;
}

inline bool HasNalType(const std::vector<NalUnit>& nals, uint8_t type) {
    for (const auto& u : nals)
        if (u.type == type) return true;
    return false;
}

// Collects every SPS and PPS of an Annex B buffer (with 4-byte start codes) into out.
inline void ExtractParamSets(const uint8_t* d, size_t n, std::vector<uint8_t>& out) {
    out.clear();
    for (const auto& u : SplitAnnexB(d, n)) {
        if (u.type != kNalSps && u.type != kNalPps) continue;
        out.insert(out.end(), {0, 0, 0, 1});
        out.insert(out.end(), d + u.payload, d + u.end);
    }
}

// Turns one encoder output buffer into the access unit we send:
//  - access unit delimiters are dropped,
//  - an IDR access unit gets SPS+PPS in front if it lacks either one,
//    (taken from cachedParamSets, which is refreshed from every AU that has both),
//  - isKeyframe reports whether an IDR slice is present.
// Returns false if there is nothing usable (no NAL units).
inline bool PrepareAccessUnit(const uint8_t* d, size_t n, std::vector<uint8_t>& cachedParamSets,
                              std::vector<uint8_t>& out, bool& isKeyframe) {
    const auto nals = SplitAnnexB(d, n);
    out.clear();
    isKeyframe = false;
    if (nals.empty()) return false;
    const bool hasSps = HasNalType(nals, kNalSps), hasPps = HasNalType(nals, kNalPps);
    isKeyframe = HasNalType(nals, kNalIdr);
    if (hasSps && hasPps) {
        std::vector<uint8_t> ps;
        ExtractParamSets(d, n, ps);
        if (!ps.empty()) cachedParamSets = ps;
    }
    if (isKeyframe && !(hasSps && hasPps) && !cachedParamSets.empty()) {
        out.insert(out.end(), cachedParamSets.begin(), cachedParamSets.end());
        if (hasSps || hasPps) {
            // Keep a lone SPS or PPS out of the copy below: the cached pair replaces it.
            for (const auto& u : nals) {
                if (u.type == kNalAud || u.type == kNalSps || u.type == kNalPps) continue;
                out.insert(out.end(), d + u.start, d + u.end);
            }
            return true;
        }
    }
    for (const auto& u : nals) {
        if (u.type == kNalAud) continue;
        out.insert(out.end(), d + u.start, d + u.end);
    }
    return !out.empty();
}

} // namespace otx
