// Implementation of light-pdf's EngineBase over mupdf's public C API.
//
// See engine_mupdf_adapter.h for why this seam exists. The parts that matter for
// the copied TextSelection.cpp / TextSearch.cpp are markers below:
//
//   [light-pdf]  copied from References/light-pdf/src/EngineMupdf.cpp, algorithm
//                unchanged; only the surrounding plumbing differs.
//   [Eukolia]    written for this worker (the boundary between light-pdf's
//                EngineBase contract and Eukolia's PdfEngine).

#include "base/Base.h"
#include "base/Pixmap.h"

#include "mupdf_engine.h"

#include <fstream>

#include "engine_mupdf_adapter.h"

// ---------------------------------------------------------------------------
// Conversions shared with light-pdf's EngineMupdf.cpp
// ---------------------------------------------------------------------------

// [light-pdf] EngineMupdf.cpp ToFzRect()/ToRectF().
static fz_rect ToFzRect(RectF rect) {
    fz_rect result = {(float)rect.x, (float)rect.y, (float)(rect.x + rect.dx), (float)(rect.y + rect.dy)};
    return result;
}

static RectF ToRectF(fz_rect rect) {
    return RectF::FromXY(rect.x0, rect.y0, rect.x1, rect.y1);
}

// [Eukolia] Adapters between light-pdf's geometry types and the worker's.
static RectF FromWorkerRect(const eukolia::RectF& r) {
    return RectF(r.x, r.y, r.dx, r.dy);
}

static eukolia::RectF ToWorkerRect(const RectF& r) {
    return eukolia::RectF{r.x, r.y, r.dx, r.dy};
}

static Str ToStr(const std::string& s) {
    return Str(const_cast<char*>(s.data()), (int)s.size());
}

// light-pdf: EngineMupdf.cpp. The engine kind is declared `extern` in
// EngineBase.h; every engine implementation defines its own.
Kind kindEngineMupdf = "engineMupdf";

// [light-pdf] EngineMupdf.cpp FzCreateViewCtm(): fitz page space -> device space.
static fz_matrix FzCreateViewCtm(fz_rect mediabox, float zoom, int rotation) {
    fz_matrix ctm = fz_pre_scale(fz_rotate((float)rotation), zoom, zoom);

    rotation = (rotation + 360) % 360;
    if (90 == rotation) {
        ctm = fz_pre_translate(ctm, 0, -mediabox.y1);
    } else if (180 == rotation) {
        ctm = fz_pre_translate(ctm, -mediabox.x1, -mediabox.y1);
    } else if (270 == rotation) {
        ctm = fz_pre_translate(ctm, -mediabox.x1, 0);
    }
    if (fz_matrix_expansion(ctm) == 0) {
        return fz_identity;
    }
    return ctm;
}

// ---------------------------------------------------------------------------
// Flat page text: light-pdf's glyph walk
// ---------------------------------------------------------------------------

namespace {

struct SeenGlyph {
    int rune;
    Rect r;
};

// [light-pdf] EngineMupdf.cpp HasSeenGlyph(): a "duplicate" glyph is one drawn
// on top of an earlier one (faux-bold double-strike or an overprinted shadow);
// its box overlaps the earlier one almost entirely. Two *adjacent* identical
// letters (the "ll" in "Yellow") sit side by side and barely overlap, so they
// must NOT be treated as duplicates. Comparing coordinates with a fixed +-1px
// tolerance cannot tell them apart once the glyph advance rounds to <=1px, which
// dropped a letter on copy (light-pdf issue #5766). Require the boxes to overlap
// by more than half the smaller glyph instead.
bool HasSeenGlyph(const Vec<SeenGlyph>& seen, int rune, const Rect& r) {
    i64 area = (i64)r.dx * (i64)r.dy;
    if (area <= 0) {
        return false;
    }
    for (const SeenGlyph& glyph : seen) {
        if (glyph.rune != rune) {
            continue;
        }
        Rect inter = glyph.r.Intersect(r);
        if (inter.IsEmpty()) {
            continue;
        }
        i64 interArea = (i64)inter.dx * (i64)inter.dy;
        i64 seenArea = (i64)glyph.r.dx * (i64)glyph.r.dy;
        i64 minArea = std::min(area, seenArea);
        if (minArea > 0 && interArea * 2 > minArea) {
            return true;
        }
    }
    return false;
}

void AddSeenGlyph(Vec<SeenGlyph>& seen, int rune, const Rect& r) {
    seen.Append({rune, r});
}

// [Eukolia] True when mupdf could not derive a real box for the glyph (it hands
// out its infinity sentinels). Such a box would poison hit testing and the
// right-edge cut in TextSelection::FillResultRects, so it is normalised to the
// canonical empty rectangle -- the same value light-pdf uses for a line
// separator, which every consumer already treats as "this codepoint has no
// geometry".
bool IsUsableGlyphRect(fz_rect r) {
    constexpr float kMinInf = (float)FZ_MIN_INF_RECT;
    constexpr float kMaxInf = (float)FZ_MAX_INF_RECT;
    if (r.x0 <= kMinInf || r.y0 <= kMinInf || r.x1 >= kMaxInf || r.y1 >= kMaxInf) {
        return false;
    }
    if (!std::isfinite(r.x0) || !std::isfinite(r.y0) || !std::isfinite(r.x1) || !std::isfinite(r.y1)) {
        return false;
    }
    return r.x1 >= r.x0 && r.y1 >= r.y0;
}

// [light-pdf] EngineMupdf.cpp AddCharUtf8().
void AddCharUtf8(fz_stext_char* c, str::Builder& s, Vec<Rect>& rects, Vec<SeenGlyph>& seen) {
    fz_rect bbox = fz_rect_from_quad(c->quad);
    if (!IsUsableGlyphRect(bbox)) {
        bbox = fz_make_rect(0, 0, 0, 0);
    }
    Rect r = ToRectF(bbox).Round();
    int rune = c->c;
    if (HasSeenGlyph(seen, rune, r)) {
        return;
    }

    bool isWhitespace = rune > 0 && rune <= 0x7f && str::IsWs((char)rune);
    bool isNonPrintable = rune <= 32 || (rune <= 0xffff && wstr::IsNonCharacter((WCHAR)rune));
    if (isNonPrintable && !isWhitespace) {
        s.AppendChar('?');
        rects.Append(r);
        AddSeenGlyph(seen, rune, r);
        return;
    }
    if (isWhitespace) {
        // collapse multiple whitespace characters into one
        char prev = s.IsEmpty() ? 0 : s.LastChar();
        if (prev == ' ' || prev == '\t' || prev == '\n' || prev == '\r') {
            return;
        }
        s.AppendChar(' ');
        rects.Append(r);
        AddSeenGlyph(seen, rune, r);
        return;
    }
    char buf[4];
    int n = fz_runetochar(buf, rune);
    if (n <= 0) {
        // [Eukolia] fz_runetochar() refuses invalid scalar values. light-pdf's
        // walk would drop the character while still recording a box, which
        // breaks the "one box per codepoint" invariant the whole selection and
        // search model rests on (EngineBase.cpp's EnsurePageText reports it and
        // TextSelection then indexes the wrong glyphs). Emit U+FFFD instead so
        // text and boxes stay aligned.
        static const char kReplacement[] = "\xef\xbf\xbd";
        s.Append(Str((char*)kReplacement, 3));
        rects.Append(r);
        AddSeenGlyph(seen, rune, r);
        return;
    }
    s.Append(Str(buf, n));
    rects.Append(r);
    AddSeenGlyph(seen, rune, r);
}

// [light-pdf] EngineMupdf.cpp AddLineSepUtf8().
void AddLineSepUtf8(str::Builder& s, Vec<Rect>& rects, Str lineSep) {
    size_t lineSepLen = (size_t)lineSep.len;
    if (lineSepLen == 0) {
        return;
    }
    // remove trailing space
    if (!s.IsEmpty() && s.LastChar() == ' ') {
        s.RemoveLast();
        rects.RemoveLast();
    }
    s.Append(lineSep);
    for (size_t i = 0; i < lineSepLen; i++) {
        rects.Append(Rect());
    }
}

// [light-pdf] EngineMupdf.cpp FzTextPageToUtf8(). `lineSep` is "\n" there, which
// is what the selection/search model expects (one codepoint per separator).
Str FzTextPageToUtf8(fz_stext_page* text, Rect** coordsOut) {
    Str lineSep = StrL("\n");
    str::Builder content;
    Vec<Rect> rects;
    Vec<SeenGlyph> seen;

    fz_stext_block* block = text->first_block;
    while (block) {
        if (block->type != FZ_STEXT_BLOCK_TEXT) {
            block = block->next;
            continue;
        }
        fz_stext_line* line = block->u.t.first_line;
        while (line) {
            fz_stext_char* c = line->first_char;
            while (c) {
                AddCharUtf8(c, content, rects, seen);
                c = c->next;
            }
            AddLineSepUtf8(content, rects, lineSep);
            line = line->next;
        }
        block = block->next;
    }

    ReportIf(Utf8CodepointCount(ToStr(content)) != len(rects));

    if (coordsOut) {
        if (len(rects) > 0) {
            *coordsOut = rects.Take();
        } else {
            *coordsOut = nullptr;
        }
    }
    return content.TakeStr();
}

} // namespace

// ---------------------------------------------------------------------------
// EngineMupdfAdapter
// ---------------------------------------------------------------------------

EngineMupdfAdapter::EngineMupdfAdapter(eukolia::PdfEngine* engine) : engine_(engine) {
    kind = kindEngineMupdf;
    defaultExt = str::Dup(StrL(".pdf"));
    fileDPI = 96.0f;
    allowsPrinting = true;
    allowsCopyingText = true;
    pageCount = engine_ ? engine_->PageCount() : 0;
    if (engine_) {
        SetFilePath(ToStr(engine_->Path()));
    }
}

EngineMupdfAdapter::~EngineMupdfAdapter() {
    for (IPageElement* element : linkElements_) {
        delete element;
    }
}

// [light-pdf] EngineMupdf::Clone(). A second EngineBase view of the same open
// document; the page-text cache starts empty, exactly as in the reference (the
// clone re-extracts on demand).
EngineBase* EngineMupdfAdapter::Clone() {
    auto* clone = new EngineMupdfAdapter(engine_);
    clone->fileDPI = fileDPI;
    clone->allowsPrinting = allowsPrinting;
    clone->allowsCopyingText = allowsCopyingText;
    clone->isPasswordProtected = isPasswordProtected;
    clone->hasPageLabels = hasPageLabels;
    clone->hideAnnotations = hideAnnotations;
    clone->disableAntiAlias = disableAntiAlias;
    clone->disableAutoLinks = disableAutoLinks;
    return clone;
}

RectF EngineMupdfAdapter::PageMediabox(int pageNo) {
    ReportIf(pageNo < 1 || pageNo > pageCount);
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return {};
    }
    return FromWorkerRect(engine_->MediaBox(pageNo - 1));
}

RectF EngineMupdfAdapter::PageContentBox(int pageNo, RenderTarget) {
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return {};
    }
    return FromWorkerRect(engine_->PageContentBox(pageNo - 1));
}

// [light-pdf] EngineMupdf::Transform().
RectF EngineMupdfAdapter::Transform(const RectF& rect, int pageNo, float zoom, int rotation, bool inverse) {
    ReportIf(zoom <= 0);
    if (zoom <= 0) {
        zoom = 1;
    }
    fz_matrix ctm = FzCreateViewCtm(ToFzRect(PageMediabox(pageNo)), zoom, rotation);
    if (inverse) {
        ctm = fz_invert_matrix(ctm);
    }
    return ToRectF(fz_transform_rect(ToFzRect(rect), ctm));
}

// [light-pdf] EngineMupdf::RenderPage(): same contract, but the pixels come from
// the worker's PdfEngine (which owns the display-list cache and the mupdf
// context) and are handed back in a light-pdf Pixmap.
//
// The worker does not route its viewer rendering through EngineBase, so nothing
// calls this today; it exists because EngineBase declares it pure virtual and
// because it is the honest place to render a page through this seam.
Pixmap* EngineMupdfAdapter::RenderPage(RenderPageArgs& args) {
    if (!engine_ || args.pageNo < 1 || args.pageNo > pageCount) {
        return nullptr;
    }
    const int pageIndex = args.pageNo - 1;

    eukolia::mupdf::PageView view = engine_->PageView_(pageIndex, args.zoom, args.rotation);
    if (view.mediaBox.IsEmpty()) {
        return nullptr;
    }

    eukolia::RectF clip{};
    eukolia::mupdf::RenderPageArgs workerArgs;
    workerArgs.pageIndex = pageIndex;
    workerArgs.view = &view;
    if (args.pageRect) {
        clip = ToWorkerRect(*args.pageRect);
        workerArgs.clip = &clip;
    }

    eukolia::mupdf::Pixmap* src = engine_->RenderPage(workerArgs);
    if (!src) {
        return nullptr;
    }

    const PixmapFormat format = src->components == 4 ? PixmapFormat::BGRA8 : PixmapFormat::BGR8;
    Pixmap* dst = AllocPixmap(src->width, src->height, format, false);
    if (!dst) {
        delete src;
        return nullptr;
    }
    dst->xres = fileDPI;
    dst->yres = fileDPI;
    const size_t rowBytes = (size_t)src->width * (size_t)src->components;
    for (int y = 0; y < src->height; y++) {
        memcpy(dst->data + (size_t)y * (size_t)dst->stride, src->samples.data() + (size_t)y * (size_t)src->stride,
               rowBytes);
    }
    delete src;
    return dst;
}

void EngineMupdfAdapter::FreeRenderedPixmap(Pixmap* pixmap) {
    if (!pixmap) {
        return;
    }
    free(pixmap->data);
    delete pixmap;
}

// [Eukolia] File I/O for GetFileData()/SaveFileAs().
//
// light-pdf does this through its base/File.h layer (file::ReadFile() /
// file::WriteFile()). That layer's Windows implementation lives in
// base/File_win.cpp, which is built on base/Win.cpp -- the whole Win32 shell,
// DDE and printing layer, which this headless worker does not link. The page
// data itself is read straight from the file that was opened, which is what
// EngineMupdf::GetFileData() does too (it keeps the loaded stream's bytes).
static bool ReadWholeFile(const std::string& path, std::string* out) {
    out->clear();
    if (path.empty()) {
        return false;
    }
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return false;
    }
    in.seekg(0, std::ios::end);
    const std::streamoff size = in.tellg();
    if (size < 0) {
        return false;
    }
    in.seekg(0, std::ios::beg);
    out->resize(static_cast<size_t>(size));
    if (size > 0) {
        in.read(&(*out)[0], size);
        if (in.gcount() != size) {
            out->clear();
            return false;
        }
    }
    return true;
}

static bool WriteWholeFile(const std::string& path, Str data) {
    if (path.empty()) {
        return false;
    }
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) {
        return false;
    }
    if (len(data) > 0) {
        out.write(data.s, data.len);
    }
    return out.good();
}

Str EngineMupdfAdapter::GetFileData() {
    if (!engine_) {
        return {};
    }
    std::string data;
    if (!ReadWholeFile(engine_->Path(), &data)) {
        return {};
    }
    return str::Dup(Str(const_cast<char*>(data.data()), (int)data.size()));
}

bool EngineMupdfAdapter::SaveFileAs(Str copyFileName) {
    Str data = GetFileData();
    if (len(data) == 0) {
        return false;
    }
    const bool ok = WriteWholeFile(std::string(copyFileName.s, static_cast<size_t>(copyFileName.len)), data);
    str::Free(data);
    return ok;
}

// [light-pdf] EngineMupdf::ExtractPageText() + ExtractPageTextLocked(): build
// the structured-text page with light-pdf's options and turn it into the flat
// "text + one box per codepoint" model with FzTextPageToUtf8().
PageText EngineMupdfAdapter::ExtractPageText(int pageNo) {
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return {};
    }
    fz_stext_page* stext = engine_->BuildStextPage(pageNo - 1);
    if (!stext) {
        return {};
    }
    fz_context* ctx = engine_->Ctx();

    PageText res;
    res.text = FzTextPageToUtf8(stext, &res.coords);
    fz_drop_stext_page(ctx, stext);
    res.len = res.text.len;
    res.nCodepoints = Utf8CodepointCount(res.text);
    return res;
}

// [light-pdf] EngineMupdf::HasClipOptimizations(): false when an image covers at
// least 90% of the page, because clipping such a page to a tile does not save
// any work. light-pdf reads the rects out of its cached image list; the same
// information is available here as mupdf's image blocks, which is what the
// structured-text device records for a page.
bool EngineMupdfAdapter::HasClipOptimizations(int pageNo) {
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return false;
    }
    RectF mediabox = PageMediabox(pageNo);
    fz_rect mbox = ToFzRect(mediabox);
    if (fz_is_empty_rect(mbox)) {
        return false;
    }

    fz_stext_page* stext = engine_->BuildStextPage(pageNo - 1);
    if (!stext) {
        return false;
    }
    bool hasClipOptimizations = true;
    for (fz_stext_block* block = stext->first_block; block; block = block->next) {
        if (block->type != FZ_STEXT_BLOCK_IMAGE) {
            continue;
        }
        fz_rect isect = fz_intersect_rect(mbox, block->bbox);
        float overlap =
            (isect.x1 - isect.x0) * (isect.y1 - isect.y0) / ((mbox.x1 - mbox.x0) * (mbox.y1 - mbox.y0));
        if (overlap >= 0.9f) {
            hasClipOptimizations = false;
            break;
        }
    }
    fz_drop_stext_page(engine_->Ctx(), stext);
    return hasClipOptimizations;
}

// [light-pdf] EngineMupdf::GetPropertyTemp(): document properties. light-pdf
// reads a cached copy of the PDF /Info dictionary; the worker's PdfEngine
// already loads the same entries (plus mupdf's own fallbacks) into its metadata
// map at open time.
TempStr EngineMupdfAdapter::GetPropertyTemp(DocProp prop) {
    if (!engine_) {
        return {};
    }
    const char* key = nullptr;
    switch (prop) {
        case DocProp::Title:
            key = "title";
            break;
        case DocProp::Author:
            key = "author";
            break;
        case DocProp::Subject:
            key = "subject";
            break;
        case DocProp::Keywords:
            key = "keywords";
            break;
        case DocProp::CreatorApp:
            key = "creator";
            break;
        case DocProp::PdfProducer:
            key = "producer";
            break;
        case DocProp::CreationDate:
            key = "creationDate";
            break;
        case DocProp::ModificationDate:
            key = "modDate";
            break;
        case DocProp::UnsupportedFeatures:
            key = "format";
            break;
        case DocProp::Encryption:
            key = "encryption";
            break;
        default:
            return {};
    }
    const auto& metadata = engine_->Metadata();
    auto it = metadata.find(key);
    if (it == metadata.end() || it->second.empty()) {
        return {};
    }
    return str::DupTemp(ToStr(it->second));
}

// [light-pdf] EngineMupdf::GetElements(): the elements a page exposes. This
// worker has no annotation/image extraction of its own, so the elements are the
// page's links -- which is the set the viewer's hit testing actually consumes.
Vec<IPageElement*> EngineMupdfAdapter::GetElements(int pageNo) {
    Vec<IPageElement*> out;
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return out;
    }
    if (linkElementsPageNo_ != pageNo) {
        for (IPageElement* element : linkElements_) {
            delete element;
        }
        linkElements_.Reset();
        linkElementsPageNo_ = pageNo;

        for (const eukolia::mupdf::LinkInfo& link : engine_->Links(pageNo - 1)) {
            IPageDestination* dest = nullptr;
            if (link.uri.empty()) {
                if (link.page <= 0) {
                    continue;
                }
                dest = NewSimpleDest(link.page, FromWorkerRect(link.box), link.zoom);
            } else {
                dest = new PageDestinationURL(ToStr(link.uri));
            }
            auto* element = new PageElementDestination(dest);
            element->pageNo = pageNo;
            element->rect = FromWorkerRect(link.box);
            linkElements_.Append(element);
        }
    }
    out.Append(linkElements_);
    return out;
}

// [light-pdf] EngineMupdf::GetElementAtPos().
IPageElement* EngineMupdfAdapter::GetElementAtPos(int pageNo, PointF pt) {
    for (IPageElement* element : GetElements(pageNo)) {
        if (element->rect.Contains(pt)) {
            return element;
        }
    }
    return nullptr;
}

// [light-pdf] EngineMupdf::BenchLoadPage(): load the page and report whether it
// is usable.
bool EngineMupdfAdapter::BenchLoadPage(int pageNo) {
    if (!engine_ || pageNo < 1 || pageNo > pageCount) {
        return false;
    }
    return !engine_->PageView_(pageNo - 1, 1.0f, 0).mediaBox.IsEmpty();
}
