// Public interface of the Eukolia native PDF engine.
//
// Ported from References/light-pdf/src/EngineMupdf.h / EngineBase.h, reduced to
// the capabilities a headless worker needs. See mupdf_engine.cpp for the port
// notes.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_MUPDF_ENGINE_H
#define EUKOLIA_NATIVE_PDF_MUPDF_ENGINE_H

#include <cstdint>
#include <cmath>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "geom.h"

extern "C" {
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
}

namespace eukolia::mupdf {

// A rendered page or tile: raw device bytes plus everything the caller needs to
// blit them without re-deriving geometry.
struct Pixmap {
    int width = 0;
    int height = 0;
    int stride = 0;
    int components = 0;  // 3 = BGR (no alpha), 4 = BGRA
    int x = 0;           // device-space origin of the returned bitmap
    int y = 0;
    RectF pageRect;      // the page-space rectangle these pixels cover
    std::vector<unsigned char> samples;
};

// light-pdf: RenderPageArgs. `view` carries the resolved view matrix so the
// render thread never has to touch the page tree.
struct RenderPageArgs {
    int pageIndex = 0;
    const struct PageView* view = nullptr;
    const RectF* clip = nullptr;  // page-space sub-rectangle, null = whole page
    /** Device scale for the page content, for the text-extraction path. */
    float contentScale = 1.0f;
    bool invert = false;
    bool gray = false;
    bool alpha = false;
    bool transparent = false;
};

// Page geometry. All coordinates the worker reports are in fitz page space:
// 72 dpi, origin at the top-left of the page's CropBox, y descending. This is
// exactly the space light-pdf's EngineBase::Transform() works in, and it is what
// a PDF viewer's overlay needs.
struct PageView {
    int pageIndex = 0;
    /** The page's displayed rectangle in fitz page space; always anchored at 0,0. */
    RectF mediaBox;
    /** fitz page space -> PDF user space. Carries /Rotate and the crop origin. */
    fz_matrix pageCtm{};
    /** Content (PDF user space) -> fitz page space. Inverse of pageCtm at 1x. */
    fz_matrix contentToPage{};
    /**
     * The view transform the reader asked for, in fitz page space:
     * `scale * userRotate`. It deliberately does NOT carry the page's own
     * /Rotate — `fz_new_display_list_from_page` and `fz_run_page` already apply
     * that to the content, so a view transform that carried it too would rotate
     * the page twice (see `RenderPage`).
     */
    fz_matrix userCtm{};
    /** Page space -> device pixels at this scale: `pageCtm * userCtm`. */
    fz_matrix ctm{};
    int pageRotate = 0;
    int userRotate = 0;
    float scale = 1.0f;
};

struct TextSpan {
    std::string text;
    RectF box;
    std::string font;
    float size = 0;
};

struct TextLine {
    RectF box;
    std::vector<TextSpan> spans;
};

struct TextBlock {
    RectF box;
    std::vector<TextLine> lines;
};

// Structured page text: the block/line/span hierarchy the IPC contract exposes
// to the renderer. The flat "one box per codepoint" model that selection and
// search are built on is NOT here any more -- it is light-pdf's PageText,
// produced by EngineMupdfAdapter (lightpdf/engine_mupdf_adapter.cpp) from the
// same structured-text page.
struct PageTextInfo {
    bool ok = false;
    float width = 0;
    float height = 0;
    std::vector<TextBlock> blocks;
};

struct LinkInfo {
    RectF box;
    std::string uri;
    int page = 0;   // 1-based target page, 0 when the link is external
    float x = 0;
    float y = 0;
    float zoom = 0;
};

struct OutlineNode {
    std::string title;
    int page = 0;  // 1-based, 0 when the target is not a page
    std::string uri;
    bool isOpen = false;
    float x = 0;
    float y = 0;
    std::vector<OutlineNode> children;
};

}  // namespace eukolia::mupdf

namespace eukolia {

struct FzLocks;

// Owns the fz_context, the open document, the page cache and the display lists.
// One instance per worker process; all public methods are safe to call from any
// thread.
class PdfEngine {
  public:
    PdfEngine();
    ~PdfEngine();

    PdfEngine(const PdfEngine&) = delete;
    PdfEngine& operator=(const PdfEngine&) = delete;

    // ---- lifecycle --------------------------------------------------------
    bool Open(const std::string& path, const std::string& password, std::string& error);

    void CloseDocument();
    bool IsOpen() const { return opened_; }
    bool NeedsPassword() const { return needsPassword_; }
    const std::string& Path() const { return path_; }
    int PageCount() const { return pageCount_; }
    const std::map<std::string, std::string>& Metadata() const { return metadata_; }

    // ---- geometry ---------------------------------------------------------
    // `userRotate` is an extra rotation on top of the page's own /Rotate, which
    // is already baked into the MediaBox (light-pdf keeps the same split between
    // PageMediabox() and the rotation passed to RenderPage()).
    mupdf::PageView PageView_(int pageIndex, float scale = 1.0f, int userRotate = 0);
    RectF MediaBox(int pageIndex) const;
    RectF PageContentBox(int pageIndex);

    // ---- rendering --------------------------------------------------------
    mupdf::Pixmap* RenderPage(const mupdf::RenderPageArgs& args);
    fz_display_list* GetOrBuildDisplayList(fz_context* ctx, int pageIndex);

    // ---- text -------------------------------------------------------------
    // Structured (block/line/span) text, for the `text` command.
    mupdf::PageTextInfo ExtractPageText(int pageIndex);
    // The page's structured-text page, built with light-pdf's options
    // (FZ_STEXT_ACCURATE_BBOXES) and run with the content->page matrix so that
    // every box it reports is in the same space as the rendered pixels.
    //
    // This is the single extraction pass in the worker: the flat per-codepoint
    // model that selection and search use is derived from the returned page by
    // EngineMupdfAdapter, not re-extracted. Caller owns the result and must
    // fz_drop_stext_page() it. Returns nullptr when the page cannot be loaded or
    // mupdf throws.
    fz_stext_page* BuildStextPage(int pageIndex);

    // ---- links / outline --------------------------------------------------
    std::vector<mupdf::LinkInfo> Links(int pageIndex);
    std::vector<mupdf::OutlineNode> Outline();

    // ---- diagnostics ------------------------------------------------------
    void PushDiagnostic(const std::string& message);
    std::vector<std::string> TakeDiagnostics();

    fz_context* BaseCtx() const;
    // Per-thread fz_context clone, mirroring light-pdf's EngineMupdf::Ctx().
    fz_context* Ctx();

  private:
    struct PageSlot {
        int pageNo = 0;
        fz_page* page = nullptr;
        fz_display_list* displayList = nullptr;
        /**
         * CropBox in fitz page space: the page's displayed rectangle, anchored at
         * (0,0), y descending. This is what all reported coordinates use.
         */
        RectF mediaBox;
        /** fitz page space -> PDF user space (from pdf_page_obj_transform). */
        fz_matrix pageCtm{};
        /** PDF user space -> fitz page space (inverse of pageCtm). */
        fz_matrix contentToPage{};
        /** The page's own /Rotate, already applied inside pageCtm. */
        int pageRotate = 0;
    };

    PageSlot* GetPageLocked(fz_context* ctx, int pageIndex);
    void LoadMetadataLocked();

    std::unique_ptr<FzLocks> locks_;
    fz_context* ctx_ = nullptr;
    fz_document* doc_ = nullptr;
    pdf_document* pdf_ = nullptr;

    mutable std::recursive_mutex stateMutex_;
    std::recursive_mutex renderMutex_;

    std::string path_;
    std::vector<PageSlot> pages_;
    int pageCount_ = 0;
    bool opened_ = false;
    bool needsPassword_ = false;
    fz_outline* outline_ = nullptr;
    std::map<std::string, std::string> metadata_;

    std::mutex clonesMutex_;
    std::map<std::thread::id, fz_context*> clones_;

    std::mutex diagnosticsMutex_;
    std::vector<std::string> diagnostics_;
};

}  // namespace eukolia

#endif  // EUKOLIA_NATIVE_PDF_MUPDF_ENGINE_H
