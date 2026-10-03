// Minimal, dependency-free JSON writer for the Eukolia PDF worker.
//
// The worker speaks a stdio binary protocol whose headers are JSON (see
// PROTOCOL.md). Only serialisation is needed -- parsing is trivial for the flat
// command headers, and parse errors are surfaced per-request rather than
// killing the process.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_JSON_H
#define EUKOLIA_NATIVE_PDF_JSON_H

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace eukolia::json {

// Appends a JSON string literal (with surrounding quotes) to `out`, escaping
// everything that RFC 8259 requires. Byte sequences that are not valid UTF-8
// (possible with damaged PDF text) are replaced with U+FFFD so the header is
// always valid JSON; the raw payload channel is unaffected.
inline void appendEscaped(std::string& out, const std::string& s) {
    out.push_back('"');
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"':
                out += "\\\"";
                i++;
                continue;
            case '\\':
                out += "\\\\";
                i++;
                continue;
            case '\b':
                out += "\\b";
                i++;
                continue;
            case '\f':
                out += "\\f";
                i++;
                continue;
            case '\n':
                out += "\\n";
                i++;
                continue;
            case '\r':
                out += "\\r";
                i++;
                continue;
            case '\t':
                out += "\\t";
                i++;
                continue;
            default:
                break;
        }
        if (c < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
            i++;
            continue;
        }
        if (c < 0x80) {
            out.push_back(static_cast<char>(c));
            i++;
            continue;
        }
        // Validate the multi-byte sequence; emit U+FFFD when it is broken.
        int extra = 0;
        unsigned int cp = 0;
        if ((c & 0xE0) == 0xC0) {
            extra = 1;
            cp = c & 0x1F;
        } else if ((c & 0xF0) == 0xE0) {
            extra = 2;
            cp = c & 0x0F;
        } else if ((c & 0xF8) == 0xF0) {
            extra = 3;
            cp = c & 0x07;
        } else {
            out += "\xEF\xBF\xBD";
            i++;
            continue;
        }
        if (i + static_cast<size_t>(extra) >= n) {
            out += "\xEF\xBF\xBD";
            i++;
            continue;
        }
        bool ok = true;
        for (int k = 1; k <= extra; k++) {
            const unsigned char cc = static_cast<unsigned char>(s[i + static_cast<size_t>(k)]);
            if ((cc & 0xC0) != 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if (!ok) {
            out += "\xEF\xBF\xBD";
            i++;
            continue;
        }
        out.append(s, i, static_cast<size_t>(extra) + 1);
        i += static_cast<size_t>(extra) + 1;
    }
    out.push_back('"');
}

// Compact streaming JSON writer. Track comma state per nesting level so callers
// never have to think about separators.
class Writer {
  public:
    std::string& Str() { return out_; }

    void BeginObject() {
        Prefix();
        out_.push_back('{');
        stack_.push_back(false);
    }
    void EndObject() {
        out_.push_back('}');
        if (!stack_.empty()) stack_.pop_back();
    }
    void BeginArray() {
        Prefix();
        out_.push_back('[');
        stack_.push_back(false);
    }
    void EndArray() {
        out_.push_back(']');
        if (!stack_.empty()) stack_.pop_back();
    }

    void Key(const char* k) {
        Prefix();
        appendEscaped(out_, k);
        out_.push_back(':');
        // The value that follows must not emit its own separator.
        pendingKey_ = true;
    }

    void Value(const std::string& s) {
        Prefix();
        appendEscaped(out_, s);
    }
    void Value(const char* s) { Value(std::string(s ? s : "")); }
    void Value(bool b) {
        Prefix();
        out_ += b ? "true" : "false";
    }
    void Value(int v) {
        Prefix();
        out_ += std::to_string(v);
    }
    void Value(unsigned int v) {
        Prefix();
        out_ += std::to_string(v);
    }
    void Value(int64_t v) {
        Prefix();
        out_ += std::to_string(v);
    }
    void Value(uint64_t v) {
        Prefix();
        out_ += std::to_string(v);
    }
    void Value(double v) {
        Prefix();
        if (!std::isfinite(v)) {
            // JSON has no NaN/Infinity; use a finite sentinel so callers can
            // still distinguish "present" from "absent".
            out_ += "0";
            return;
        }
        char buf[40];
        std::snprintf(buf, sizeof(buf), "%.6g", v);
        out_ += buf;
    }
    void Value(float v) { Value(static_cast<double>(v)); }
    void Null() {
        Prefix();
        out_ += "null";
    }

    // Convenience: {"k": v, ...}
    void Member(const char* k, const std::string& s) {
        Key(k);
        Value(s);
    }
    void Member(const char* k, const char* s) {
        Key(k);
        Value(s);
    }
    void Member(const char* k, bool b) {
        Key(k);
        Value(b);
    }
    void Member(const char* k, int v) {
        Key(k);
        Value(v);
    }
    void Member(const char* k, int64_t v) {
        Key(k);
        Value(v);
    }
    void Member(const char* k, uint64_t v) {
        Key(k);
        Value(v);
    }
    void Member(const char* k, double v) {
        Key(k);
        Value(v);
    }
    void Member(const char* k, float v) {
        Key(k);
        Value(static_cast<double>(v));
    }

    // Object/array members: MemberArray("pages") << ... ; the returned writer is
    // this one, so the calls chain.
    Writer& MemberArray(const char* k) {
        Key(k);
        BeginArray();
        return *this;
    }
    Writer& MemberObject(const char* k) {
        Key(k);
        BeginObject();
        return *this;
    }

    // Array element helpers.
    void Element(const std::string& s) { Value(s); }
    void Element(const char* s) { Value(s); }
    void Element(int v) { Value(v); }
    void Element(double v) { Value(v); }
    void ElementObject() { BeginObject(); }
    void ElementArray() { BeginArray(); }

    std::string Take() { return std::move(out_); }

  private:
    void Prefix() {
        if (pendingKey_) {
            pendingKey_ = false;
            return;
        }
        if (!stack_.empty()) {
            if (stack_.back()) {
                out_.push_back(',');
            }
            stack_.back() = true;
        }
    }

    std::string out_;
    std::vector<bool> stack_;
    bool pendingKey_ = false;
};

}  // namespace eukolia::json

#endif  // EUKOLIA_NATIVE_PDF_JSON_H
