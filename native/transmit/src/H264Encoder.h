// Open Tethery — native Transmit plugin
// H.264 encoding through a Media Foundation encoder MFT (hardware if there is
// one, otherwise Microsoft's software encoder). Constrained baseline, no
// B-frames, low latency, CBR. Input NV12, output Annex B access units with
// SPS/PPS in front of every IDR.
//
// Threading: everything is called from one thread (the sender's worker, with
// COM initialised). Nothing here blocks: Encode() drops the frame if the
// encoder is busy, Poll() only reads what is ready.
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

namespace otx {

struct EncodedAu {
    std::vector<uint8_t> data;       // Annex B, SPS+PPS first when keyframe
    bool keyframe = false;
    int64_t sampleTime100ns = 0;     // as given to Encode()
};

class H264Encoder {
public:
    H264Encoder();
    ~H264Encoder();

    H264Encoder(const H264Encoder&) = delete;
    H264Encoder& operator=(const H264Encoder&) = delete;

    // width/height must be even. bitrate in bit/s. Tries hardware encoders
    // first when allowHardware. Returns false if no encoder could be set up.
    bool Init(int width, int height, int fps, int bitrate, bool allowHardware);
    void Shutdown();

    bool IsOpen() const;
    bool IsHardware() const { return hardware_; }
    int Width() const { return width_; }
    int Height() const { return height_; }

    // The next accepted frame becomes an IDR.
    void RequestKeyframe();

    // nv12 = width*height*3/2 bytes. *accepted = false when the encoder was
    // busy and the frame was dropped. Returns false on a fatal error (the
    // caller should Shutdown and fall back).
    bool Encode(const uint8_t* nv12, int64_t sampleTime100ns, bool* accepted);

    // Collects finished output without blocking. False on a fatal error.
    bool Poll();
    bool PopOutput(EncodedAu& out);

    uint64_t Submitted() const;
    uint64_t Produced() const;

    // Target bitrate for a picture size (about 8 Mbit/s at 1080p).
    static int BitrateFor(int width, int height);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    int width_ = 0, height_ = 0;
    bool hardware_ = false;
};

} // namespace otx
