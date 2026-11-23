// Open Tethery — native Transmit plugin
// JPEG encoding through Windows Imaging Component (WIC).
#include "JpegEncoder.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <wincodec.h>
#include <propidl.h>

#include <cstring>

namespace otx {

namespace {

template <typename T>
void SafeRelease(T*& p) {
    if (p) {
        p->Release();
        p = nullptr;
    }
}

} // namespace

JpegEncoder::JpegEncoder() = default;

JpegEncoder::~JpegEncoder() { Release(); }

bool JpegEncoder::Init() {
    if (factory_) return true;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&factory_));
    return SUCCEEDED(hr) && factory_ != nullptr;
}

void JpegEncoder::Release() { SafeRelease(factory_); }

bool JpegEncoder::Encode(const uint8_t* bgr, int width, int height, int stride,
                         float quality, std::vector<uint8_t>& out) {
    if (!factory_ || !bgr || width <= 0 || height <= 0 || stride < width * 3) return false;

    IStream* stream = nullptr;
    IWICBitmapEncoder* encoder = nullptr;
    IWICBitmapFrameEncode* frame = nullptr;
    IPropertyBag2* props = nullptr;
    bool ok = false;

    do {
        if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) break;
        if (FAILED(factory_->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder))) break;
        if (FAILED(encoder->Initialize(stream, WICBitmapEncoderNoCache))) break;
        if (FAILED(encoder->CreateNewFrame(&frame, &props))) break;

        if (props) {
            PROPBAG2 opt = {};
            wchar_t name[] = L"ImageQuality";
            opt.pstrName = name;
            VARIANT v;
            VariantInit(&v);
            v.vt = VT_R4;
            v.fltVal = quality < 0.f ? 0.f : (quality > 1.f ? 1.f : quality);
            props->Write(1, &opt, &v);  // non-fatal if the option is rejected
        }
        if (FAILED(frame->Initialize(props))) break;
        if (FAILED(frame->SetSize(static_cast<UINT>(width), static_cast<UINT>(height)))) break;

        WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
        if (FAILED(frame->SetPixelFormat(&fmt))) break;
        if (!IsEqualGUID(fmt, GUID_WICPixelFormat24bppBGR)) break;  // encoder wants something else

        const UINT bufSize = static_cast<UINT>(stride) * static_cast<UINT>(height);
        if (FAILED(frame->WritePixels(static_cast<UINT>(height), static_cast<UINT>(stride), bufSize,
                                      const_cast<BYTE*>(bgr))))
            break;
        if (FAILED(frame->Commit())) break;
        if (FAILED(encoder->Commit())) break;

        HGLOBAL mem = nullptr;
        if (FAILED(GetHGlobalFromStream(stream, &mem)) || !mem) break;
        STATSTG st = {};
        if (FAILED(stream->Stat(&st, STATFLAG_NONAME))) break;
        const size_t size = static_cast<size_t>(st.cbSize.QuadPart);
        const void* src = GlobalLock(mem);
        if (!src) break;
        out.resize(size);
        if (size) std::memcpy(out.data(), src, size);
        GlobalUnlock(mem);
        ok = size > 0;
    } while (false);

    SafeRelease(props);
    SafeRelease(frame);
    SafeRelease(encoder);
    SafeRelease(stream);
    return ok;
}

} // namespace otx
