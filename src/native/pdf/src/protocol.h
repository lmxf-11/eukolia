// Stdio binary framing for the Eukolia native PDF worker.
//
// See PROTOCOL.md for the full description. Summary:
//
//   frame := uint32 payloadLength | payload
//   payload := uint8 frameType | uint32 requestId | body
//
// `payloadLength` counts the bytes after itself (frameType + requestId + body)
// and must be >= 5. Frames are little-endian. Bodies are JSON for control
// frames and raw bytes for pixel frames.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_PROTOCOL_H
#define EUKOLIA_NATIVE_PDF_PROTOCOL_H

#include <cstdint>
#include <string>

namespace eukolia::proto {

// Bump when the framing or the frame-type table changes incompatibly. The
// TypeScript bridge refuses to talk to a worker whose version differs.
constexpr uint32_t kProtocolVersion = 1;

enum class FrameType : uint8_t {
    // main -> worker
    Request = 1,
    Cancel = 2,
    Ping = 3,
    Shutdown = 4,

    // worker -> main
    Response = 128,      // JSON result for a completed request
    Error = 129,         // JSON error for a request (or for the stream itself)
    Pixels = 130,        // JSON header + raw pixel payload
    Ready = 131,         // emitted once at startup, JSON capabilities
    Log = 132,           // unsolicited diagnostics, JSON
    Pong = 133,
};

inline const char* FrameTypeName(FrameType t) {
    switch (t) {
        case FrameType::Request:
            return "request";
        case FrameType::Cancel:
            return "cancel";
        case FrameType::Ping:
            return "ping";
        case FrameType::Shutdown:
            return "shutdown";
        case FrameType::Response:
            return "response";
        case FrameType::Error:
            return "error";
        case FrameType::Pixels:
            return "pixels";
        case FrameType::Ready:
            return "ready";
        case FrameType::Log:
            return "log";
        case FrameType::Pong:
            return "pong";
    }
    return "unknown";
}

// Maximum accepted frame body. A malformed or hostile length prefix must not
// make the worker attempt a multi-gigabyte allocation.
constexpr uint32_t kMaxFrameBytes = 512u * 1024u * 1024u;

inline void PutU32LE(std::string& out, uint32_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>((v >> 8) & 0xFF));
    out.push_back(static_cast<char>((v >> 16) & 0xFF));
    out.push_back(static_cast<char>((v >> 24) & 0xFF));
}

inline uint32_t GetU32LE(const unsigned char* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

// Serialise one complete frame: length prefix, type, request id, body.
inline std::string MakeFrame(FrameType type, uint32_t requestId, const std::string& body) {
    const uint32_t payloadLen = static_cast<uint32_t>(5 + body.size());
    std::string out;
    out.reserve(4 + payloadLen);
    PutU32LE(out, payloadLen);
    out.push_back(static_cast<char>(type));
    PutU32LE(out, requestId);
    out.append(body);
    return out;
}

// Splits a raw pixel payload into header-bytes and blob without copying the
// blob. `body` is the request/response body as read from the wire.
struct PixelsBody {
    uint32_t headerBytes = 0;
    const char* header = nullptr;
    const char* blob = nullptr;
    size_t blobBytes = 0;
    uint32_t blobBytes32 = 0;
};

}  // namespace eukolia::proto

#endif  // EUKOLIA_NATIVE_PDF_PROTOCOL_H
