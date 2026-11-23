// Open Tethery — native Transmit plugin
// JPEG encoding through Windows Imaging Component (WIC). One encoder per
// thread: WIC objects are created on the worker thread that uses them.
#pragma once

#include <cstdint>
#include <vector>

struct IWICImagingFactory;

namespace otx {

class JpegEncoder {
public:
    JpegEncoder();
    ~JpegEncoder();

    JpegEncoder(const JpegEncoder&) = delete;
    JpegEncoder& operator=(const JpegEncoder&) = delete;

    // Must be called on the thread that will call Encode (after COM is
    // initialised on that thread). Returns false if WIC is unavailable.
    bool Init();
    void Release();

    // Encodes a top-down 24-bit BGR image. quality is 0..1.
    // On success replaces the contents of out with the JPEG file bytes.
    bool Encode(const uint8_t* bgr, int width, int height, int stride,
                float quality, std::vector<uint8_t>& out);

private:
    IWICImagingFactory* factory_ = nullptr;
};

} // namespace otx
