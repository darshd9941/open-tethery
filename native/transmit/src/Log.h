// Open Tethery — native Transmit plugin
// Debug logging via OutputDebugString only (view with DebugView or a debugger).
#pragma once

#include <cstdarg>
#include <cstdio>
#include <cstring>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace otx {

inline void Log(const char* fmt, ...) {
    char buf[512];
    int n = std::snprintf(buf, sizeof(buf), "[OpenTethery] ");
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf + n, sizeof(buf) - n - 2, fmt, args);
    va_end(args);
    size_t len = std::strlen(buf);
    buf[len] = '\n';
    buf[len + 1] = '\0';
    OutputDebugStringA(buf);
}

} // namespace otx
