// Open Tethery — native Transmit plugin
// Premiere Pro Mercury Transmit entry point. Receives Program Monitor frames,
// copies the newest one into FrameSender's slot and returns immediately.
// Video via PushVideo; audio via "push audio" (Transmit interface v4): the
// user's normal speakers stay the clock device and this plugin is an extra,
// mirrored output, so we offer no playback clock.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include "PrSDKTransmit.h"
#include "PrSDKPPixSuite.h"
#include "PrSDKTimeSuite.h"
#include "PrSDKStringSuite.h"
#include "PrSDKPixelFormat.h"
#include "SPBasic.h"

#include "AudioPush.h"
#include "FrameSender.h"
#include "Log.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

namespace {

using otx::Log;

constexpr const char* kPluginGuid = "c761851a-d4cf-4c81-ac09-c3d9997172c7";
constexpr const wchar_t* kDisplayName = L"Open Tethery (phone preview)";
constexpr PrTime kProtocolTicksPerSecond = 254016000000LL;

struct InstanceData {
    csSDK_int32 id = 0;
    int seqWidth = 0;
    int seqHeight = 0;
    PrTime ticksPerFrame = 0;
    int64_t lastTimeTicks = -1;  // protocol ticks
    bool clockPlaying = false;   // only set if the host ever drives our clock calls
};

struct ModuleState {
    SPBasicSuite* sp = nullptr;
    PrSDKPPixSuite* ppix = nullptr;
    PrSDKStringSuite* strings = nullptr;
    PrTime hostTicksPerSecond = kProtocolTicksPerSecond;
    otx::FrameSender* sender = nullptr;
    csSDK_int32 hostInterfaceVersion = tmInterfaceVersion;
    int instanceCount = 0;
    bool invertRows = false;  // escape hatch: OPEN_TETHERY_FLIP=1
    bool audioEnabled = false;      // push audio offered (host >= v4, not After Effects, not disabled)
    bool audioAsDevice = true;      // also report outAudioAvailable (OPEN_TETHERY_AUDIO=push turns this off)
};

ModuleState g;

// --- Helpers ---------------------------------------------------------------

int64_t ToProtocolTicks(PrTime t) {
    if (t < 0) return -1;
    if (g.hostTicksPerSecond == kProtocolTicksPerSecond || g.hostTicksPerSecond <= 0) return t;
    return static_cast<int64_t>(static_cast<long double>(t) * kProtocolTicksPerSecond /
                                static_cast<long double>(g.hostTicksPerSecond));
}

uint64_t Gcd(uint64_t a, uint64_t b) {
    while (b) {
        uint64_t t = a % b;
        a = b;
        b = t;
    }
    return a;
}

// ticks-per-frame -> exact rational fps (e.g. 30000/1001).
void FrameRateFromTicks(PrTime ticksPerFrame, uint32_t& num, uint32_t& den) {
    num = 0;
    den = 1;
    if (ticksPerFrame <= 0 || g.hostTicksPerSecond <= 0) return;
    uint64_t n = static_cast<uint64_t>(g.hostTicksPerSecond);
    uint64_t d = static_cast<uint64_t>(ticksPerFrame);
    const uint64_t k = Gcd(n, d);
    n /= k;
    d /= k;
    if (n > 0xFFFFFFFFull || d > 0xFFFFFFFFull) {
        const double fps = static_cast<double>(g.hostTicksPerSecond) / static_cast<double>(ticksPerFrame);
        n = static_cast<uint64_t>(fps * 1000.0 + 0.5);
        d = 1000;
    }
    num = static_cast<uint32_t>(n);
    den = static_cast<uint32_t>(d);
}

// After Effects loads Transmit plug-ins too (Video Preview) but has no use for
// audio from them. Detect it by the host executable name.
bool HostIsAfterEffects() {
    char path[MAX_PATH] = {};
    if (!GetModuleFileNameA(nullptr, path, MAX_PATH)) return false;
    for (char* c = path; *c; ++c) *c = static_cast<char>(std::tolower(static_cast<unsigned char>(*c)));
    return std::strstr(path, "afterfx") != nullptr;
}

void ConfigureAudio() {
    char mode[16] = {};
    GetEnvironmentVariableA("OPEN_TETHERY_AUDIO", mode, sizeof(mode));
    const bool off = std::strcmp(mode, "0") == 0 || std::strcmp(mode, "off") == 0;
    g.audioAsDevice = std::strcmp(mode, "push") != 0;
    g.audioEnabled = !off && g.hostInterfaceVersion >= tmInterfaceVersion4 && !HostIsAfterEffects();
}

void AcquireSuites(piSuitesPtr suites) {
    if (g.sp || !suites || !suites->utilFuncs || !suites->utilFuncs->getSPBasicSuite) return;
    g.sp = suites->utilFuncs->getSPBasicSuite();
    if (!g.sp) return;

    const void* p = nullptr;
    if (g.sp->AcquireSuite(kPrSDKPPixSuite, kPrSDKPPixSuiteVersion, &p) == kSPNoError && p)
        g.ppix = static_cast<PrSDKPPixSuite*>(const_cast<void*>(p));
    else
        Log("PPix suite unavailable");

    p = nullptr;
    if (g.sp->AcquireSuite(kPrSDKStringSuite, kPrSDKStringSuiteVersion, &p) == kSPNoError && p)
        g.strings = static_cast<PrSDKStringSuite*>(const_cast<void*>(p));
    else
        Log("String suite unavailable (audio output names will be empty)");

    p = nullptr;
    if (g.sp->AcquireSuite(kPrSDKTimeSuite, kPrSDKTimeSuiteVersion, &p) == kSPNoError && p) {
        auto* time = static_cast<PrSDKTimeSuite*>(const_cast<void*>(p));
        PrTime tps = 0;
        if (time->GetTicksPerSecond && time->GetTicksPerSecond(&tps) == suiteError_NoError && tps > 0)
            g.hostTicksPerSecond = tps;
        g.sp->ReleaseSuite(kPrSDKTimeSuite, kPrSDKTimeSuiteVersion);
    }
}

void ReleaseSuites() {
    if (g.sp && g.ppix) g.sp->ReleaseSuite(kPrSDKPPixSuite, kPrSDKPPixSuiteVersion);
    if (g.sp && g.strings) g.sp->ReleaseSuite(kPrSDKStringSuite, kPrSDKStringSuiteVersion);
    g.ppix = nullptr;
    g.strings = nullptr;
    g.sp = nullptr;
}

void StopSender() {
    if (g.sender) {
        g.sender->Stop();
        delete g.sender;
        g.sender = nullptr;
    }
}

InstanceData* Inst(const tmInstance* instance) {
    return instance ? static_cast<InstanceData*>(instance->ioPrivateInstanceData) : nullptr;
}

// Copies a BGRA 8u PPix into the sender's staging buffer as top-down rows.
// Uncompressed Premiere frames have a lower-left origin: GetPixels points at
// the bottom row and adding rowBytes (which may be negative) moves one row up.
bool CopyFrame(PPixHand ppix, const InstanceData* inst, PrTime hostTime) {
    PrPixelFormat fmt = PrPixelFormat_Invalid;
    if (g.ppix->GetPixelFormat(ppix, &fmt) != suiteError_NoError || fmt != PrPixelFormat_BGRA_4444_8u)
        return false;

    prRect bounds = {};
    if (g.ppix->GetBounds(ppix, &bounds) != suiteError_NoError) return false;
    const int width = bounds.right - bounds.left;
    const int height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return false;

    csSDK_int32 rowBytes = 0;
    if (g.ppix->GetRowBytes(ppix, &rowBytes) != suiteError_NoError) return false;
    const size_t lineBytes = static_cast<size_t>(width) * 4;
    if (static_cast<size_t>(std::abs(static_cast<long long>(rowBytes))) < lineBytes) return false;

    char* base = nullptr;
    if (g.ppix->GetPixels(ppix, PrPPixBufferAccess_ReadOnly, &base) != suiteError_NoError || !base)
        return false;

    otx::RawFrame& f = g.sender->LockStaging();
    try {
        f.pixels.resize(lineBytes * height);
    } catch (...) {
        g.sender->AbandonStaging();
        return false;
    }
    for (int y = 0; y < height; ++y) {
        // y is the output (top-down) row; source row index counts from the bottom.
        const int srcRow = g.invertRows ? y : (height - 1 - y);
        const char* src = base + static_cast<ptrdiff_t>(srcRow) * rowBytes;
        std::memcpy(f.pixels.data() + static_cast<size_t>(y) * lineBytes, src, lineBytes);
    }
    f.width = width;
    f.height = height;
    f.seqWidth = (inst && inst->seqWidth > 0) ? inst->seqWidth : width;
    f.seqHeight = (inst && inst->seqHeight > 0) ? inst->seqHeight : height;
    const int64_t t = ToProtocolTicks(hostTime);
    f.timeTicks = t >= 0 ? t : (inst ? inst->lastTimeTicks : -1);
    FrameRateFromTicks(inst ? inst->ticksPerFrame : 0, f.fpsNum, f.fpsDen);
    g.sender->CommitStaging();
    return true;
}

// --- tmModule callbacks ----------------------------------------------------

tmResult Startup(tmStdParms* ioStdParms, tmPluginInfo* outInfo) {
    if (!outInfo) return tmResult_ErrorInvalidArgument;
    try {
        if (ioStdParms) AcquireSuites(ioStdParms->piSuites);

        std::memset(outInfo->outIdentifier.mGUID, 0, sizeof(outInfo->outIdentifier.mGUID));
        std::strncpy(outInfo->outIdentifier.mGUID, kPluginGuid, sizeof(outInfo->outIdentifier.mGUID) - 1);
        outInfo->outPriority = 0;
        ConfigureAudio();
        outInfo->outAudioAvailable = (g.audioEnabled && g.audioAsDevice) ? kPrTrue : kPrFalse;
        outInfo->outAudioDefaultEnabled = kPrFalse;  // the user opts in; speakers stay primary
        outInfo->outClockAvailable = kPrFalse;  // never the clock: Premiere keeps the speakers as clock device
        outInfo->outVideoAvailable = kPrTrue;
        outInfo->outVideoDefaultEnabled = kPrTrue;
        std::memset(outInfo->outDisplayName, 0, sizeof(outInfo->outDisplayName));
        const size_t maxChars = sizeof(outInfo->outDisplayName) / sizeof(outInfo->outDisplayName[0]) - 1;
        for (size_t i = 0; i < maxChars && kDisplayName[i]; ++i)
            outInfo->outDisplayName[i] = static_cast<prUTF16Char>(kDisplayName[i]);
        outInfo->outHideInUI = kPrFalse;
        outInfo->outHasSetup = kPrFalse;
        outInfo->outInterfaceVersion = std::min<csSDK_int32>(g.hostInterfaceVersion, tmInterfaceVersion);
        if (outInfo->outInterfaceVersion >= tmInterfaceVersion4) {
            outInfo->outPushAudioAvailable = g.audioEnabled ? kPrTrue : kPrFalse;
            outInfo->outHasStreaming = kPrFalse;
        }

        if (!g.sender) {
            char flip[8] = {};
            g.invertRows = GetEnvironmentVariableA("OPEN_TETHERY_FLIP", flip, sizeof(flip)) > 0 && flip[0] == '1';
            g.sender = new (std::nothrow) otx::FrameSender();
            if (g.sender) g.sender->Start();
        }
        Log("plugin started (host ticks/s %lld%s, push audio %s)", static_cast<long long>(g.hostTicksPerSecond),
            g.invertRows ? ", rows inverted by OPEN_TETHERY_FLIP" : "", g.audioEnabled ? "on" : "off");
        return tmResult_Success;
    } catch (...) {
        return tmResult_ErrorUnknown;
    }
}

tmResult Shutdown(tmStdParms*) {
    try {
        StopSender();
        Log("plugin shut down");
    } catch (...) {
    }
    return tmResult_Success;
}

tmResult NeedsReset(const tmStdParms*, prBool* outResetModule) {
    if (outResetModule) *outResetModule = kPrFalse;
    return tmResult_Success;
}

tmResult CreateInstance(const tmStdParms*, tmInstance* ioInstance) {
    if (!ioInstance) return tmResult_ErrorInvalidArgument;
    auto* inst = new (std::nothrow) InstanceData();
    if (!inst) return tmResult_ErrorMemory;
    inst->id = ioInstance->inInstanceID;
    inst->seqWidth = ioInstance->inVideoWidth;
    inst->seqHeight = ioInstance->inVideoHeight;
    inst->ticksPerFrame = ioInstance->inVideoFrameRate;
    ioInstance->ioPrivateInstanceData = inst;
    ++g.instanceCount;
    Log("instance %d created (%dx%d, %lld ticks/frame)", inst->id, inst->seqWidth, inst->seqHeight,
        static_cast<long long>(inst->ticksPerFrame));
    return tmResult_Success;
}

tmResult DisposeInstance(const tmStdParms*, tmInstance* ioInstance) {
    if (!ioInstance) return tmResult_ErrorInvalidArgument;
    auto* inst = Inst(ioInstance);
    if (inst) {
        Log("instance %d disposed", inst->id);
        delete inst;
        ioInstance->ioPrivateInstanceData = nullptr;
        if (g.instanceCount > 0) --g.instanceCount;
    }
    if (g.instanceCount == 0 && g.sender) g.sender->SetPlaying(false);
    return tmResult_Success;
}

tmResult QueryVideoMode(const tmStdParms*, const tmInstance* inInstance, csSDK_int32 inQueryIterationIndex,
                        tmVideoMode* outVideoMode) {
    if (!outVideoMode) return tmResult_ErrorInvalidArgument;
    if (inQueryIterationIndex != 0) return tmResult_ErrorUnsupported;
    if (auto* inst = Inst(inInstance)) {
        // The sequence settings may have changed since CreateInstance.
        if (inInstance->inVideoWidth > 0) inst->seqWidth = inInstance->inVideoWidth;
        if (inInstance->inVideoHeight > 0) inst->seqHeight = inInstance->inVideoHeight;
        if (inInstance->inVideoFrameRate > 0) inst->ticksPerFrame = inInstance->inVideoFrameRate;
    }
    outVideoMode->outWidth = 0;  // any size; we downscale ourselves
    outVideoMode->outHeight = 0;
    outVideoMode->outPARNum = 0;
    outVideoMode->outPARDen = 0;
    outVideoMode->outFieldType = prFieldsAny;
    outVideoMode->outPixelFormat = PrPixelFormat_BGRA_4444_8u;
    std::memset(&outVideoMode->outStreamLabel, 0, sizeof(outVideoMode->outStreamLabel));
    outVideoMode->outLatency = 0;  // a preview: never ask Premiere to delay its own monitor
    return tmResult_Success;
}

tmResult ActivateDeactivate(const tmStdParms*, const tmInstance* inInstance, PrActivationEvent inEvent,
                            prBool inAudioActive, prBool inVideoActive) {
    const auto* inst = Inst(inInstance);
    Log("instance %d activate event %d audio %d video %d", inst ? inst->id : -1, static_cast<int>(inEvent),
        static_cast<int>(inAudioActive), static_cast<int>(inVideoActive));
    if (!inVideoActive && g.sender) g.sender->SetPlaying(false);
    return tmResult_Success;
}

// Not expected (outClockAvailable is false), but harmless if the host calls
// them: they only update the playing state.
tmResult StartPlaybackClock(const tmStdParms*, const tmInstance* inInstance, const tmPlaybackClock* inClock) {
    if (!inClock) return tmResult_ErrorInvalidArgument;
    const bool playing = inClock->inPlayMode == playmode_Playing && inClock->inSpeed != 0.0f;
    if (auto* inst = Inst(inInstance)) {
        inst->clockPlaying = playing;
        const int64_t t = ToProtocolTicks(inClock->inStartTime);
        if (t >= 0) inst->lastTimeTicks = t;
    }
    if (g.sender) g.sender->SetPlaying(playing);
    return tmResult_Success;
}

tmResult StopPlaybackClock(const tmStdParms*, const tmInstance* inInstance) {
    if (auto* inst = Inst(inInstance)) inst->clockPlaying = false;
    if (g.sender) g.sender->SetPlaying(false);
    return tmResult_Success;
}

tmResult PushVideo(const tmStdParms*, const tmInstance* inInstance, const tmPushVideo* inPushVideo) {
    if (!inPushVideo) return tmResult_ErrorInvalidArgument;

    try {
        auto* inst = Inst(inInstance);
        const bool playing = inPushVideo->inPlayMode == playmode_Playing;
        if (inst) {
            inst->clockPlaying = playing;
            const int64_t t = ToProtocolTicks(inPushVideo->inTime);
            if (t >= 0) inst->lastTimeTicks = t;
        }

        if (g.sender && g.ppix && inPushVideo->inFrames && inPushVideo->inFrameCount > 0) {
            g.sender->SetPlaying(playing);
            if (g.sender->WantCapture(playing)) {
                // Prefer the unlabeled (normal) stream; fall back to the first frame.
                size_t pick = 0;
                for (size_t i = 0; i < inPushVideo->inFrameCount; ++i) {
                    const char* label = inPushVideo->inFrames[i].inStreamLabel;
                    if (!label || !*label) {
                        pick = i;
                        break;
                    }
                }
                PPixHand frame = inPushVideo->inFrames[pick].inFrame;
                if (frame) CopyFrame(frame, inst, inPushVideo->inTime);  // skips non-BGRA-8u frames
            }
        }
    } catch (...) {
        // Never let an exception cross into Premiere.
    }

    // We own every PPix we were handed, whether we used it or not.
    if (g.ppix && inPushVideo->inFrames) {
        for (size_t i = 0; i < inPushVideo->inFrameCount; ++i) {
            if (inPushVideo->inFrames[i].inFrame) g.ppix->Dispose(inPushVideo->inFrames[i].inFrame);
        }
    }
    return tmResult_Success;
}


// --- Push audio ------------------------------------------------------------

tmResult QueryAudioMode(const tmStdParms*, const tmInstance*, csSDK_int32 inQueryIterationIndex,
                        tmAudioMode* outAudioMode) {
    if (!outAudioMode) return tmResult_ErrorInvalidArgument;
    if (!g.audioEnabled || inQueryIterationIndex != 0) return tmResult_ErrorUnsupported;
    std::memset(outAudioMode, 0, sizeof(*outAudioMode));
    outAudioMode->outAudioSampleRate = static_cast<float>(otx::kAudioRate);
    outAudioMode->outMaxBufferSize = 8192;  // frames per PushAudio call we are prepared to receive
    outAudioMode->outNumChannels = 2;
    outAudioMode->outChannelLabels[0] = kPrAudioChannelLabel_FrontLeft;
    outAudioMode->outChannelLabels[1] = kPrAudioChannelLabel_FrontRight;
    outAudioMode->outLatency = 0;
    if (g.strings && g.strings->AllocateFromUTF16) {
        static const wchar_t* const names[2] = {L"Open Tethery L", L"Open Tethery R"};
        for (int i = 0; i < 2; ++i) {
            prUTF16Char buf[32] = {};
            for (size_t k = 0; k + 1 < sizeof(buf) / sizeof(buf[0]) && names[i][k]; ++k)
                buf[k] = static_cast<prUTF16Char>(names[i][k]);
            g.strings->AllocateFromUTF16(buf, &outAudioMode->outAudioOutputNames[i]);  // host disposes
        }
    }
    return tmResult_Success;
}

tmResult StartPushAudio(const tmStdParms*, const tmInstance* inInstance, PrTime, float, PrTime, PrTime, prBool,
                        prBool, csSDK_uint32*) {
    // outSamplesPerFrame is left at the host default: PushAudio handles any buffer size.
    if (g.sender) g.sender->SetAudioActive(true);
    const auto* inst = Inst(inInstance);
    Log("push audio started (instance %d)", inst ? inst->id : -1);
    return tmResult_Success;
}

// May run on an audio thread at the same time as the other calls: touches only
// thread-local scratch memory and the sender's lock-protected queue, never the network.
tmResult PushAudio(const tmStdParms*, const tmInstance*, const tmPushAudio* inPushAudio) {
    if (!inPushAudio) return tmResult_ErrorInvalidArgument;
    try {
        otx::FrameSender* sender = g.sender;
        const uint32_t ch = inPushAudio->inNumChannels;
        const uint32_t n = inPushAudio->inNumSamples;
        if (!sender || !inPushAudio->inBuffers || ch == 0 || ch > 16 || n == 0) return tmResult_Success;
        for (uint32_t c = 0; c < ch; ++c)
            if (!inPushAudio->inBuffers[c]) return tmResult_Success;
        thread_local std::vector<int16_t> scratch;
        scratch.clear();
        otx::InterleaveStereoInt16(inPushAudio->inBuffers, ch, n, scratch);
        sender->PushAudio(scratch.data(), n, ToProtocolTicks(inPushAudio->inTime));
    } catch (...) {
    }
    return tmResult_Success;
}

tmResult StopPushAudio(const tmStdParms*, const tmInstance*) {
    if (g.sender) g.sender->SetAudioActive(false);
    Log("push audio stopped");
    return tmResult_Success;
}

} // namespace

// --- Exported entry point ----------------------------------------------------

extern "C" __declspec(dllexport) tmResult xTransmitEntry(csSDK_int32 inInterfaceVersion, prBool inLoadModule,
                                                         piSuitesPtr piSuites, tmModule* outModule) {
    try {
        if (inLoadModule) {
            if (!outModule) return tmResult_ErrorInvalidArgument;
            if (inInterfaceVersion < tmInterfaceVersion1) return tmResult_ErrorUnsupported;
            g.hostInterfaceVersion = inInterfaceVersion;
            ConfigureAudio();
            AcquireSuites(piSuites);

            // Only write the members that exist in the host's interface version.
            outModule->Startup = Startup;
            outModule->Shutdown = Shutdown;
            outModule->SetupDialog = nullptr;
            outModule->NeedsReset = NeedsReset;
            outModule->CreateInstance = CreateInstance;
            outModule->DisposeInstance = DisposeInstance;
            outModule->QueryAudioMode = QueryAudioMode;
            outModule->QueryVideoMode = QueryVideoMode;
            outModule->ActivateDeactivate = ActivateDeactivate;
            outModule->StartPlaybackClock = StartPlaybackClock;
            outModule->StopPlaybackClock = StopPlaybackClock;
            outModule->PushVideo = PushVideo;
            if (inInterfaceVersion >= tmInterfaceVersion4) {
                outModule->StartPushAudio = StartPushAudio;
                outModule->PushAudio = PushAudio;
                outModule->StopPushAudio = StopPushAudio;
                outModule->SetStreamingStateChangedCallback = nullptr;
                outModule->EnableStreaming = nullptr;
                outModule->IsStreamingEnabled = nullptr;
                outModule->IsStreamingActive = nullptr;
            }
            Log("module loaded (host interface %d)", static_cast<int>(inInterfaceVersion));
        } else {
            StopSender();
            ReleaseSuites();
            Log("module unloaded");
        }
        return tmResult_Success;
    } catch (...) {
        return tmResult_ErrorUnknown;
    }
}
