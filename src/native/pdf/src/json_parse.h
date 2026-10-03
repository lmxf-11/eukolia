// A small, allocation-light JSON value/parser used for the worker's command
// headers. It intentionally supports the full JSON grammar (objects, arrays,
// strings with escapes and \uXXXX, numbers, true/false/null) so that callers do
// not have to agree on a restricted dialect, but it is not a validating
// document parser: it is used on frames whose length is already known.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_JSON_PARSE_H
#define EUKOLIA_NATIVE_PDF_JSON_PARSE_H

#include <cmath>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace eukolia::json {

enum class Type { Null, Bool, Number, String, Array, Object };

class Value {
  public:
    Type type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string str;
    std::vector<Value> array;
    std::map<std::string, Value> object;

    bool IsNull() const { return type == Type::Null; }
    bool IsObject() const { return type == Type::Object; }
    bool IsArray() const { return type == Type::Array; }
    bool IsString() const { return type == Type::String; }
    bool IsNumber() const { return type == Type::Number; }
    bool IsBool() const { return type == Type::Bool; }

    // Missing keys yield a Null value; callers use the Get* helpers below which
    // apply defaults, so a partially-specified request is never fatal.
    const Value& operator[](const char* key) const {
        static const Value kNull;
        if (type != Type::Object) return kNull;
        auto it = object.find(key);
        return it == object.end() ? kNull : it->second;
    }

    std::string GetString(const char* key, const std::string& def = std::string()) const {
        const Value& v = (*this)[key];
        if (v.type == Type::String) return v.str;
        if (v.type == Type::Number) {
            char buf[40];
            std::snprintf(buf, sizeof(buf), "%.10g", v.number);
            return buf;
        }
        return def;
    }
    double GetNumber(const char* key, double def = 0) const {
        const Value& v = (*this)[key];
        if (v.type == Type::Number) return v.number;
        if (v.type == Type::Bool) return v.boolean ? 1 : 0;
        if (v.type == Type::String) {
            // Accept numbers sent as strings for robustness.
            char* end = nullptr;
            const double d = std::strtod(v.str.c_str(), &end);
            if (end && end != v.str.c_str()) return d;
        }
        return def;
    }
    int GetInt(const char* key, int def = 0) const {
        const double d = GetNumber(key, static_cast<double>(def));
        if (!std::isfinite(d)) return def;
        return static_cast<int>(d < 0 ? d - 0.5 : d + 0.5);
    }
    bool GetBool(const char* key, bool def = false) const {
        const Value& v = (*this)[key];
        if (v.type == Type::Bool) return v.boolean;
        if (v.type == Type::Number) return v.number != 0;
        if (v.type == Type::String) return v.str == "true" || v.str == "1";
        return def;
    }
    bool Has(const char* key) const {
        return type == Type::Object && object.find(key) != object.end();
    }
};

namespace detail {

struct Parser {
    const char* p;
    const char* end;
    std::string error;

    void SkipWs() {
        while (p < end) {
            const char c = *p;
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                p++;
            } else {
                break;
            }
        }
    }
    bool Fail(const char* msg) {
        if (error.empty()) error = msg;
        return false;
    }

    bool ParseString(std::string& out) {
        if (p >= end || *p != '"') return Fail("expected string");
        p++;
        out.clear();
        while (p < end) {
            const unsigned char c = static_cast<unsigned char>(*p);
            if (c == '"') {
                p++;
                return true;
            }
            if (c == '\\') {
                p++;
                if (p >= end) return Fail("truncated escape");
                const char e = *p++;
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        unsigned int cp = 0;
                        if (!ParseHex4(cp)) return false;
                        // Combine a UTF-16 surrogate pair when present.
                        if (cp >= 0xD800 && cp <= 0xDBFF && p + 1 < end && p[0] == '\\' && p[1] == 'u') {
                            p += 2;
                            unsigned int lo = 0;
                            if (!ParseHex4(lo)) return false;
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                AppendUtf8(out, cp);
                                cp = lo;
                            }
                        }
                        AppendUtf8(out, cp);
                        break;
                    }
                    default:
                        return Fail("bad escape");
                }
                continue;
            }
            out.push_back(static_cast<char>(c));
            p++;
        }
        return Fail("unterminated string");
    }

    bool ParseHex4(unsigned int& cp) {
        if (p + 4 > end) return Fail("truncated \\u");
        cp = 0;
        for (int i = 0; i < 4; i++) {
            const char h = p[i];
            cp <<= 4;
            if (h >= '0' && h <= '9') {
                cp |= static_cast<unsigned int>(h - '0');
            } else if (h >= 'a' && h <= 'f') {
                cp |= static_cast<unsigned int>(h - 'a' + 10);
            } else if (h >= 'A' && h <= 'F') {
                cp |= static_cast<unsigned int>(h - 'A' + 10);
            } else {
                return Fail("bad \\u digit");
            }
        }
        p += 4;
        return true;
    }

    static void AppendUtf8(std::string& out, unsigned int cp) {
        if (cp <= 0x7F) {
            out.push_back(static_cast<char>(cp));
        } else if (cp <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool ParseValue(Value& v) {
        SkipWs();
        if (p >= end) return Fail("unexpected end");
        const char c = *p;
        if (c == '{') {
            p++;
            v.type = Type::Object;
            SkipWs();
            if (p < end && *p == '}') {
                p++;
                return true;
            }
            for (;;) {
                SkipWs();
                std::string key;
                if (!ParseString(key)) return false;
                SkipWs();
                if (p >= end || *p != ':') return Fail("expected ':'");
                p++;
                Value child;
                if (!ParseValue(child)) return false;
                v.object.emplace(std::move(key), std::move(child));
                SkipWs();
                if (p < end && *p == ',') {
                    p++;
                    continue;
                }
                if (p < end && *p == '}') {
                    p++;
                    return true;
                }
                return Fail("expected ',' or '}'");
            }
        }
        if (c == '[') {
            p++;
            v.type = Type::Array;
            SkipWs();
            if (p < end && *p == ']') {
                p++;
                return true;
            }
            for (;;) {
                Value child;
                if (!ParseValue(child)) return false;
                v.array.push_back(std::move(child));
                SkipWs();
                if (p < end && *p == ',') {
                    p++;
                    continue;
                }
                if (p < end && *p == ']') {
                    p++;
                    return true;
                }
                return Fail("expected ',' or ']'");
            }
        }
        if (c == '"') {
            v.type = Type::String;
            return ParseString(v.str);
        }
        if (end - p >= 4 && std::string(p, p + 4) == "true") {
            v.type = Type::Bool;
            v.boolean = true;
            p += 4;
            return true;
        }
        if (end - p >= 5 && std::string(p, p + 5) == "false") {
            v.type = Type::Bool;
            v.boolean = false;
            p += 5;
            return true;
        }
        if (end - p >= 4 && std::string(p, p + 4) == "null") {
            v.type = Type::Null;
            p += 4;
            return true;
        }
        // number
        {
            char* numEnd = nullptr;
            const double d = std::strtod(p, &numEnd);
            if (!numEnd || numEnd == p) return Fail("invalid value");
            v.type = Type::Number;
            v.number = d;
            p = numEnd;
            return true;
        }
    }
};

}  // namespace detail

// Returns true on success. On failure `error` explains what went wrong so the
// worker can answer the request with a specific error rather than dying.
inline bool Parse(const std::string& text, Value& out, std::string& error) {
    detail::Parser parser{text.data(), text.data() + text.size(), {}};
    if (!parser.ParseValue(out)) {
        error = parser.error.empty() ? "invalid JSON" : parser.error;
        return false;
    }
    parser.SkipWs();
    if (parser.p != parser.end) {
        error = "trailing data after JSON value";
        return false;
    }
    return true;
}

}  // namespace eukolia::json

#endif  // EUKOLIA_NATIVE_PDF_JSON_PARSE_H
