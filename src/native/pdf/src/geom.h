// Geometry helpers shared by the engine and the render cache.
//
// RectF/Rect mirror the light-pdf types used throughout RenderCache.cpp and
// EngineMupdf.cpp so the ported algorithms read the same way. The fz_* inline
// helpers in MuPDF's geometry.h are used wherever they exist.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_GEOM_H
#define EUKOLIA_NATIVE_PDF_GEOM_H

#include <algorithm>
#include <cmath>
#include <cstdint>

extern "C" {
#include <mupdf/fitz.h>
}

namespace eukolia {

// Floating-point rectangle, PDF user space.
struct RectF {
    float x = 0;
    float y = 0;
    float dx = 0;
    float dy = 0;

    static RectF FromXY(float x0, float y0, float x1, float y1) {
        RectF r;
        r.x = std::min(x0, x1);
        r.y = std::min(y0, y1);
        r.dx = std::fabs(x1 - x0);
        r.dy = std::fabs(y1 - y0);
        return r;
    }
    bool IsEmpty() const { return dx <= 0 || dy <= 0; }
    float x1() const { return x + dx; }
    float y1() const { return y + dy; }
    RectF Intersect(const RectF& o) const {
        const float nx = std::max(x, o.x);
        const float ny = std::max(y, o.y);
        const float nx1 = std::min(x1(), o.x1());
        const float ny1 = std::min(y1(), o.y1());
        if (nx1 <= nx || ny1 <= ny) return RectF{};
        return RectF::FromXY(nx, ny, nx1, ny1);
    }
    RectF Union(const RectF& o) const {
        if (IsEmpty()) return o;
        if (o.IsEmpty()) return *this;
        return RectF::FromXY(std::min(x, o.x), std::min(y, o.y), std::max(x1(), o.x1()), std::max(y1(), o.y1()));
    }
};

// Integer rectangle with an included origin, used for pixmap bounds.
struct Rect {
    int x = 0;
    int y = 0;
    int dx = 0;
    int dy = 0;

    bool IsEmpty() const { return dx <= 0 || dy <= 0; }
};

inline RectF ToRectF(fz_rect r) {
    return RectF::FromXY(r.x0, r.y0, r.x1, r.y1);
}

inline fz_rect ToFzRect(const RectF& r) {
    return fz_make_rect(r.x, r.y, r.x + r.dx, r.y + r.dy);
}

inline Rect ToRect(fz_irect r) {
    Rect out;
    out.x = r.x0;
    out.y = r.y0;
    out.dx = r.x1 - r.x0;
    out.dy = r.y1 - r.y0;
    return out;
}

inline RectF ToRectF(const Rect& r) {
    return RectF::FromXY(static_cast<float>(r.x), static_cast<float>(r.y), static_cast<float>(r.x + r.dx),
                         static_cast<float>(r.y + r.dy));
}

// light-pdf: Geom.cpp NormalizeRotation(). Rejects non-multiples of 90 by
// falling back to 0, matching the reference behaviour.
inline int NormalizeRotation(int rotation) {
    while (rotation < 0) rotation += 360;
    while (rotation >= 360) rotation -= 360;
    if ((rotation % 90) != 0) return 0;
    return rotation;
}

// light-pdf: EngineMupdf.cpp FzCreateViewCtm(). The mediabox must be the rotated
// MediaBox (what pdf_page_obj_transform returns), because the page content
// stream already applies the page's own /Rotate.
inline fz_matrix FzCreateViewCtm(fz_rect mediabox, float zoom, int rotation) {
    fz_matrix ctm = fz_pre_scale(fz_rotate(static_cast<float>(rotation)), zoom, zoom);
    rotation = ((rotation % 360) + 360) % 360;
    if (rotation == 90) {
        ctm = fz_pre_translate(ctm, 0, -mediabox.y1);
    } else if (rotation == 180) {
        ctm = fz_pre_translate(ctm, -mediabox.x1, -mediabox.y1);
    } else if (rotation == 270) {
        ctm = fz_pre_translate(ctm, -mediabox.x1, 0);
    }
    if (fz_matrix_expansion(ctm) <= 0) {
        return fz_identity;
    }
    return ctm;
}

// light-pdf: EngineMupdf.cpp Transform().
inline RectF TransformRect(const RectF& rect, fz_rect mediabox, float zoom, int rotation, bool inverse = false) {
    fz_matrix ctm = FzCreateViewCtm(mediabox, zoom <= 0 ? 1.0f : zoom, NormalizeRotation(rotation));
    if (inverse) {
        ctm = fz_invert_matrix(ctm);
    }
    return ToRectF(fz_transform_rect(ToFzRect(rect), ctm));
}

inline float RectArea(const RectF& r) {
    return r.IsEmpty() ? 0.0f : r.dx * r.dy;
}

}  // namespace eukolia

#endif  // EUKOLIA_NATIVE_PDF_GEOM_H
