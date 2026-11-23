# Premiere Live Stream (native Mercury Transmit plugin)

Goal: real-time program-monitor streaming to phones on the local network, like Tethery.

Scope:
- Native C++ Premiere Pro plugin using Mercury Transmit SDK
- Receive BGRA frames from Program Monitor
- Encode H.264/H.265
- Stream over WebSocket/HTTP to browser viewer
- Audio capture optional

Prerequisites:
- Adobe Premiere Pro SDK
- Visual Studio C++ toolchain
- CMake or MSBuild

Status: scaffold only.