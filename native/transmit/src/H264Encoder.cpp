// Open Tethery — native Transmit plugin
// Media Foundation H.264 encoder wrapper. See H264Encoder.h.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <strmif.h>
#include <codecapi.h>
#include <wmcodecdsp.h>
#include <wrl/client.h>

#include "AnnexB.h"
#include "H264Encoder.h"
#include "Log.h"

#include <algorithm>
#include <cstring>
#include <deque>

using Microsoft::WRL::ComPtr;

namespace otx {

namespace {

// Constrained baseline profile value for MF_MT_MPEG2_PROFILE (eAVEncH264VProfile_ConstrainedBase).
constexpr UINT32 kProfileConstrainedBase = eAVEncH264VProfile_ConstrainedBase;
constexpr UINT32 kProfileBase = eAVEncH264VProfile_Base;

HRESULT SetCodecUI4(ICodecAPI* api, const GUID& key, ULONG value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_UI4;
    v.ulVal = value;
    return api->SetValue(&key, &v);
}

HRESULT SetCodecBool(ICodecAPI* api, const GUID& key, bool value) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BOOL;
    v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
    return api->SetValue(&key, &v);
}

void AddColor(IMFMediaType* t) {
    // BT.709, limited range; the encoder writes these into the SPS VUI.
    t->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    t->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    t->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    t->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
}

} // namespace

struct H264Encoder::Impl {
    ComPtr<IMFTransform> mft;
    ComPtr<IMFMediaEventGenerator> events;
    ComPtr<ICodecAPI> codec;
    bool started = false;  // MFStartup done
    bool async = false;
    bool outProvidesSamples = false;
    DWORD outSampleSize = 0;
    int needInput = 0;
    int width = 0, height = 0, fps = 30, bitrate = 0;
    bool forceKey = false;
    bool fatal = false;
    uint64_t submitted = 0, produced = 0;
    std::deque<EncodedAu> out;
    std::vector<uint8_t> paramSets;

    bool CreateAndConfigure(bool allowHardware, bool& hardware);
    bool Configure(bool hardware);
    bool NegotiateTypes();
    HRESULT ProcessOneOutput();
    void Collect(IMFSample* sample);
    bool DrainSync();
    bool PumpEvents();
    void Reset() {
        events.Reset();
        codec.Reset();
        mft.Reset();
        async = false;
        needInput = 0;
    }
};

H264Encoder::H264Encoder() : impl_(new Impl) {}
H264Encoder::~H264Encoder() { Shutdown(); }

int H264Encoder::BitrateFor(int width, int height) {
    const double scale = static_cast<double>(width) * height / (1920.0 * 1080.0);
    const double bps = 8.0e6 * scale;
    return static_cast<int>(std::max(1.5e6, std::min(12.0e6, bps)));
}

bool H264Encoder::IsOpen() const { return impl_ && impl_->mft && !impl_->fatal; }
void H264Encoder::RequestKeyframe() { impl_->forceKey = true; }
uint64_t H264Encoder::Submitted() const { return impl_->submitted; }
uint64_t H264Encoder::Produced() const { return impl_->produced; }

bool H264Encoder::Init(int width, int height, int fps, int bitrate, bool allowHardware) {
    Shutdown();
    Impl& d = *impl_;
    if (width < 16 || height < 16 || (width & 1) || (height & 1)) return false;
    d.width = width_ = width;
    d.height = height_ = height;
    d.fps = fps > 0 ? fps : 30;
    d.bitrate = bitrate > 0 ? bitrate : BitrateFor(width, height);
    d.fatal = false;
    d.forceKey = false;
    d.submitted = d.produced = 0;
    d.out.clear();
    d.paramSets.clear();

    if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) {
        Log("H.264: MFStartup failed");
        return false;
    }
    d.started = true;
    if (!d.CreateAndConfigure(allowHardware, hardware_)) {
        Shutdown();
        return false;
    }
    Log("H.264 encoder ready: %dx%d, %d kbit/s, %s, %s", width, height, d.bitrate / 1000,
        hardware_ ? "hardware" : "software", d.async ? "async" : "sync");
    return true;
}

void H264Encoder::Shutdown() {
    if (!impl_) return;
    Impl& d = *impl_;
    if (d.mft) {
        d.mft->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
        d.mft->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    }
    d.Reset();
    d.out.clear();
    if (d.started) {
        MFShutdown();
        d.started = false;
    }
    hardware_ = false;
}

bool H264Encoder::Impl::CreateAndConfigure(bool allowHardware, bool& hardware) {
    hardware = false;
    if (allowHardware) {
        MFT_REGISTER_TYPE_INFO outType = {MFMediaType_Video, MFVideoFormat_H264};
        IMFActivate** acts = nullptr;
        UINT32 count = 0;
        const HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                                     nullptr, &outType, &acts, &count);
        if (SUCCEEDED(hr) && acts) {
            for (UINT32 i = 0; i < count && !mft; ++i) {
                ComPtr<IMFTransform> t;
                if (SUCCEEDED(acts[i]->ActivateObject(IID_PPV_ARGS(&t)))) {
                    mft = t;
                    if (Configure(true)) {
                        hardware = true;
                    } else {
                        Log("H.264: hardware encoder %u rejected our settings", i);
                        acts[i]->ShutdownObject();
                        Reset();
                    }
                }
            }
            for (UINT32 i = 0; i < count; ++i) acts[i]->Release();
            CoTaskMemFree(acts);
        }
        if (hardware) return true;
    }
    if (FAILED(CoCreateInstance(CLSID_CMSH264EncoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&mft)))) {
        Log("H.264: software encoder MFT unavailable");
        return false;
    }
    if (!Configure(false)) {
        Log("H.264: software encoder rejected our settings");
        Reset();
        return false;
    }
    return true;
}

bool H264Encoder::Impl::Configure(bool hardware) {
    ComPtr<IMFAttributes> attrs;
    if (SUCCEEDED(mft->GetAttributes(&attrs)) && attrs) {
        UINT32 isAsync = 0;
        attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (isAsync) {
            if (FAILED(attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE))) return false;
            if (FAILED(mft.As(&events))) return false;
            async = true;
        }
        if (hardware) attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
    }
    mft.As(&codec);  // optional, but we want it
    if (codec) {
        SetCodecBool(codec.Get(), CODECAPI_AVLowLatencyMode, true);
        SetCodecBool(codec.Get(), CODECAPI_AVEncCommonRealTime, true);
        SetCodecUI4(codec.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
        SetCodecUI4(codec.Get(), CODECAPI_AVEncCommonMeanBitRate, static_cast<ULONG>(bitrate));
        SetCodecUI4(codec.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
        SetCodecUI4(codec.Get(), CODECAPI_AVEncMPVGOPSize, static_cast<ULONG>(fps * 2));  // backstop; the sender forces IDRs itself
    }
    if (!NegotiateTypes()) return false;

    MFT_OUTPUT_STREAM_INFO info = {};
    if (SUCCEEDED(mft->GetOutputStreamInfo(0, &info))) {
        outProvidesSamples = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
        outSampleSize = info.cbSize ? info.cbSize : static_cast<DWORD>(width * height);
    }
    mft->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    mft->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
    mft->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

    // The sequence header (SPS+PPS) is usually available from the negotiated output type.
    ComPtr<IMFMediaType> cur;
    if (SUCCEEDED(mft->GetOutputCurrentType(0, &cur)) && cur) {
        UINT32 n = 0;
        if (SUCCEEDED(cur->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &n)) && n > 0) {
            std::vector<uint8_t> blob(n);
            if (SUCCEEDED(cur->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, blob.data(), n, &n)))
                ExtractParamSets(blob.data(), n, paramSets);
        }
    }
    return true;
}

bool H264Encoder::Impl::NegotiateTypes() {
    // Output type first (encoders need it before input). Try the preferred form, then simpler ones.
    struct Variant {
        UINT32 profile;
        bool color;
        const char* name;
    };
    const Variant variants[] = {
        {kProfileConstrainedBase, true, "constrained baseline + colour"},
        {kProfileConstrainedBase, false, "constrained baseline"},
        {kProfileBase, true, "baseline + colour"},
        {kProfileBase, false, "baseline"},
    };
    bool outOk = false;
    for (const Variant& v : variants) {
        ComPtr<IMFMediaType> t;
        if (FAILED(MFCreateMediaType(&t))) return false;
        t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        t->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        t->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrate));
        MFSetAttributeSize(t.Get(), MF_MT_FRAME_SIZE, width, height);
        MFSetAttributeRatio(t.Get(), MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(t.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        t->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        t->SetUINT32(MF_MT_MPEG2_PROFILE, v.profile);
        t->SetUINT32(MF_MT_MPEG2_LEVEL, eAVEncH264VLevel4);
        if (v.color) AddColor(t.Get());
        if (SUCCEEDED(mft->SetOutputType(0, t.Get(), 0))) {
            Log("H.264 output type: %s", v.name);
            outOk = true;
            break;
        }
    }
    if (!outOk) return false;

    ComPtr<IMFMediaType> in;
    if (FAILED(MFCreateMediaType(&in))) return false;
    in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(in.Get(), MF_MT_FRAME_SIZE, width, height);
    MFSetAttributeRatio(in.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(in.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    in->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(width));
    AddColor(in.Get());
    if (SUCCEEDED(mft->SetInputType(0, in.Get(), 0))) return true;
    // Some encoders reject the colour tags on input; retry plain.
    in->DeleteItem(MF_MT_VIDEO_PRIMARIES);
    in->DeleteItem(MF_MT_TRANSFER_FUNCTION);
    in->DeleteItem(MF_MT_YUV_MATRIX);
    in->DeleteItem(MF_MT_VIDEO_NOMINAL_RANGE);
    return SUCCEEDED(mft->SetInputType(0, in.Get(), 0));
}

void H264Encoder::Impl::Collect(IMFSample* sample) {
    if (!sample) return;
    LONGLONG t = 0;
    sample->GetSampleTime(&t);
    ComPtr<IMFMediaBuffer> buf;
    if (FAILED(sample->ConvertToContiguousBuffer(&buf)) || !buf) return;
    BYTE* p = nullptr;
    DWORD len = 0;
    if (FAILED(buf->Lock(&p, nullptr, &len)) || !p) return;
    EncodedAu au;
    bool key = false;
    if (PrepareAccessUnit(p, len, paramSets, au.data, key)) {
        au.keyframe = key;
        au.sampleTime100ns = t;
        out.push_back(std::move(au));
        ++produced;
    }
    buf->Unlock();
}

// Returns S_OK when an output was collected, MF_E_TRANSFORM_NEED_MORE_INPUT when
// there is none, or another failure.
HRESULT H264Encoder::Impl::ProcessOneOutput() {
    for (int attempt = 0; attempt < 2; ++attempt) {
        MFT_OUTPUT_DATA_BUFFER ob = {};
        ob.dwStreamID = 0;
        ComPtr<IMFSample> mine;
        if (!outProvidesSamples) {
            ComPtr<IMFMediaBuffer> mb;
            if (FAILED(MFCreateSample(&mine)) || FAILED(MFCreateMemoryBuffer(outSampleSize, &mb))) return E_OUTOFMEMORY;
            mine->AddBuffer(mb.Get());
            ob.pSample = mine.Get();
        }
        DWORD status = 0;
        const HRESULT hr = mft->ProcessOutput(0, 1, &ob, &status);
        if (ob.pEvents) ob.pEvents->Release();
        if (SUCCEEDED(hr)) {
            IMFSample* s = ob.pSample;
            Collect(s);
            if (outProvidesSamples && s) s->Release();
            return S_OK;
        }
        if (outProvidesSamples && ob.pSample) ob.pSample->Release();
        if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
            ComPtr<IMFMediaType> t;
            if (SUCCEEDED(mft->GetOutputAvailableType(0, 0, &t)) && SUCCEEDED(mft->SetOutputType(0, t.Get(), 0))) continue;
            return hr;
        }
        return hr;
    }
    return E_FAIL;
}

bool H264Encoder::Impl::DrainSync() {
    for (int i = 0; i < 16; ++i) {
        const HRESULT hr = ProcessOneOutput();
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return true;
        if (FAILED(hr)) {
            Log("H.264: ProcessOutput failed 0x%08lx", static_cast<unsigned long>(hr));
            return false;
        }
    }
    return true;
}

bool H264Encoder::Impl::PumpEvents() {
    if (!events) return true;
    for (int i = 0; i < 64; ++i) {
        ComPtr<IMFMediaEvent> ev;
        const HRESULT hr = events->GetEvent(MF_EVENT_FLAG_NO_WAIT, &ev);
        if (hr == MF_E_NO_EVENTS_AVAILABLE) return true;
        if (FAILED(hr)) return false;
        MediaEventType type = MEUnknown;
        ev->GetType(&type);
        if (type == METransformNeedInput) {
            ++needInput;
        } else if (type == METransformHaveOutput) {
            const HRESULT ohr = ProcessOneOutput();
            if (FAILED(ohr) && ohr != MF_E_TRANSFORM_NEED_MORE_INPUT) {
                Log("H.264: async ProcessOutput failed 0x%08lx", static_cast<unsigned long>(ohr));
                return false;
            }
        } else if (type == MEError) {
            HRESULT status = E_FAIL;
            ev->GetStatus(&status);
            Log("H.264: encoder error event 0x%08lx", static_cast<unsigned long>(status));
            return false;
        }
    }
    return true;
}

bool H264Encoder::Poll() {
    Impl& d = *impl_;
    if (!d.mft || d.fatal) return false;
    const bool ok = d.async ? d.PumpEvents() : d.DrainSync();
    if (!ok) d.fatal = true;
    return ok;
}

bool H264Encoder::Encode(const uint8_t* nv12, int64_t sampleTime100ns, bool* accepted) {
    Impl& d = *impl_;
    if (accepted) *accepted = false;
    if (!d.mft || d.fatal) return false;
    if (!Poll()) return false;
    if (d.async && d.needInput <= 0) return true;  // busy: drop this frame

    const DWORD size = static_cast<DWORD>(d.width * d.height * 3 / 2);
    ComPtr<IMFMediaBuffer> mb;
    ComPtr<IMFSample> sample;
    if (FAILED(MFCreateMemoryBuffer(size, &mb)) || FAILED(MFCreateSample(&sample))) return true;
    BYTE* dst = nullptr;
    if (FAILED(mb->Lock(&dst, nullptr, nullptr)) || !dst) return true;
    std::memcpy(dst, nv12, size);
    mb->Unlock();
    mb->SetCurrentLength(size);
    sample->AddBuffer(mb.Get());
    sample->SetSampleTime(sampleTime100ns);
    sample->SetSampleDuration(10000000LL / d.fps);

    if (d.forceKey && d.codec) {
        SetCodecUI4(d.codec.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
        d.forceKey = false;
    }
    HRESULT hr = d.mft->ProcessInput(0, sample.Get(), 0);
    if (hr == MF_E_NOTACCEPTING && !d.async) {
        if (!d.DrainSync()) {
            d.fatal = true;
            return false;
        }
        hr = d.mft->ProcessInput(0, sample.Get(), 0);
    }
    if (hr == MF_E_NOTACCEPTING) return true;  // busy: drop
    if (FAILED(hr)) {
        Log("H.264: ProcessInput failed 0x%08lx", static_cast<unsigned long>(hr));
        d.fatal = true;
        return false;
    }
    ++d.submitted;
    if (d.async) --d.needInput;
    if (accepted) *accepted = true;
    return Poll();
}

bool H264Encoder::PopOutput(EncodedAu& out) {
    Impl& d = *impl_;
    if (d.out.empty()) return false;
    out = std::move(d.out.front());
    d.out.pop_front();
    return true;
}

} // namespace otx
