# Native Transmit plugin (Premiere Pro)

Our own thin Mercury Transmit plugin. Premiere hands it every frame the Program
Monitor shows (and the timeline audio); it forwards them to the local helper,
which streams to phones.

Builds against the Adobe Premiere Pro C++ SDK headers, which are not in this
repo. See the top-level README for where to put the SDK.

Note: Adobe's own Transmitter sample is marked "ADOBE CONFIDENTIAL" and is not
copied into this repo. The code here is written from scratch against the SDK
headers and documentation.
