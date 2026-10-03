// light-pdf's EngineBase, implemented on top of the Eukolia worker's MuPDF layer.
//
// The vendored light-pdf text/selection/search/layout modules
// (TextSelection.cpp, TextSearch.cpp, DocumentLayout.cpp) talk to the document
// exclusively through the abstract EngineBase interface declared in
// lightpdf/EngineBase.h. light-pdf's own implementation of that interface,
// EngineMupdf.cpp, is welded to the Windows viewer (display lists, dark-mode
// profiles, annotations, printing, HBITMAP-backed RenderedBitmaps), so it cannot
// be copied as-is. This file is the seam instead: it implements exactly the
// EngineBase surface those three modules use -- page geometry, the
// content->page transform, and the flat "one box per codepoint" page text -- on
// top of mupdf's public C API, through the worker's PdfEngine.
//
// The extraction algorithm itself (the glyph walk, the duplicate-glyph filter,
// the whitespace collapsing, the line separators) is light-pdf's, copied from
// EngineMupdf.cpp's FzTextPageToUtf8()/AddCharUtf8()/AddLineSepUtf8()/
// HasSeenGlyph() and NewTextPageOptions(); see engine_mupdf_adapter.cpp.
//
// Include base/Base.h (and therefore this project's include order) before this
// header, exactly like the rest of the light-pdf sources.
//
// NOTE: light-pdf's EngineBase.h has no include guard (it is meant to be
// included exactly once per translation unit, after TreeModel.h). This header
// therefore performs that single inclusion itself; a translation unit that
// includes engine_mupdf_adapter.h must not include EngineBase.h again.

#ifndef EUKOLIA_LIGHTPDF_ENGINE_MUPDF_ADAPTER_H
#define EUKOLIA_LIGHTPDF_ENGINE_MUPDF_ADAPTER_H

#include "base/Base.h"
#include "DocProperties.h"
#include "TreeModel.h"
#include "EngineBase.h"

namespace eukolia {
class PdfEngine;
} // namespace eukolia

struct EngineMupdfAdapter : EngineBase {
    explicit EngineMupdfAdapter(eukolia::PdfEngine* engine);
    ~EngineMupdfAdapter() override;

    // light-pdf: EngineMupdf::Clone(). A second view of the same open document.
    EngineBase* Clone() override;

    RectF PageMediabox(int pageNo) override;
    RectF PageContentBox(int pageNo, RenderTarget target = RenderTarget::View) override;
    RectF Transform(const RectF& rect, int pageNo, float zoom, int rotation, bool inverse = false) override;
    Pixmap* RenderPage(RenderPageArgs& args) override;

    Str GetFileData() override;
    bool SaveFileAs(Str copyFileName) override;

    PageText ExtractPageText(int pageNo) override;

    bool HasClipOptimizations(int pageNo) override;

    TempStr GetPropertyTemp(DocProp prop) override;

    Vec<IPageElement*> GetElements(int pageNo) override;
    IPageElement* GetElementAtPos(int pageNo, PointF pt) override;

    bool BenchLoadPage(int pageNo) override;

    // The wrapped worker engine.
    eukolia::PdfEngine* Wrapped() const { return engine_; }

    // Releases a Pixmap returned by RenderPage().
    //
    // light-pdf's counterpart is FreePixmap() (base/Pixmap.h). That inline
    // helper also knows how to free a GDI DIB-section-backed Pixmap through
    // Win.cpp's FreePixmapNativeBitmap(), and Win.cpp is the whole Windows
    // shell/DDE/printing layer, which this headless worker does not link.
    // Every Pixmap this adapter produces is plain malloc-backed (hbmp is null),
    // so releasing the pixel buffer and the struct is exactly what FreePixmap()
    // does on that path.
    static void FreeRenderedPixmap(Pixmap* pixmap);

  private:
    eukolia::PdfEngine* engine_ = nullptr;
    // Elements handed out by GetElements() are owned here and stay valid for the
    // lifetime of the adapter, which is light-pdf's ownership model ("caller
    // must delete the Vec but not the elements inside the vector").
    Vec<IPageElement*> linkElements_;
    int linkElementsPageNo_ = -1;
};

#endif // EUKOLIA_LIGHTPDF_ENGINE_MUPDF_ADAPTER_H
