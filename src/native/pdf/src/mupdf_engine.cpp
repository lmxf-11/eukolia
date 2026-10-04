// Eukolia native PDF engine: the MuPDF-facing half of the worker.
//
// This is a port of the engine-facing parts of light-pdf's
// References/light-pdf/src/EngineMupdf.cpp. The page/view transform, the tile
// geometry, page loading, text extraction, link and outline handling and the
// render path are copied in structure and adapted to a headless,
// request-driven process:
//
//   * Win32 (HWND, WM_*, Direct2D, GDI, DPI awareness) is gone. Nothing in this
//     file touches a window, a device context or the registry.
//   * light-pdf's EngineBase/Pixmap/RenderedBitmap/custom Str+Vec containers are
//     replaced with std:: types and a plain byte buffer. The algorithms and
//     their comments are preserved.
//   * light-pdf resolves links and outlines through IPageElement/IPageDestination
//     wrappers for hit-testing and hover popups; here the same MuPDF calls are
//     used but the results are emitted directly as JSON.
//   * Per-thread fz_context clones are kept: light-pdf's Ctx() returns a
//     per-thread clone, and that is what makes its render threads safe.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#include "mupdf_engine.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>

#include "geom.h"
#include "json.h"

extern "C" {
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
}

// Copied from light-pdf's MuPDF_Exports.cpp (which in turn copies values from
// mupdf's geometry.c). In a DLL build these symbols only exist inside
// libmupdf.dll, but the headers' inline geometry helpers reference them by name
// with C linkage, so the executable has to provide its own copies. MuPDF's own
// header text warns that a stale value silently corrupts behaviour, so the
// values MUST match upstream exactly.
//
// These must be at global scope with C linkage. Inside a namespace the symbol
// would be mangled; at namespace scope C++ would give `const` internal linkage
// and the reference would never reach the linker.
extern "C" {
const fz_matrix fz_identity = {1, 0, 0, 1, 0, 0};
const fz_rect fz_empty_rect = {FZ_MAX_INF_RECT, FZ_MAX_INF_RECT, FZ_MIN_INF_RECT, FZ_MIN_INF_RECT};
const fz_irect fz_empty_irect = {FZ_MAX_INF_RECT, FZ_MAX_INF_RECT, FZ_MIN_INF_RECT, FZ_MIN_INF_RECT};
const fz_rect fz_infinite_rect = {FZ_MIN_INF_RECT, FZ_MIN_INF_RECT, FZ_MAX_INF_RECT, FZ_MAX_INF_RECT};
const fz_irect fz_infinite_irect = {FZ_MIN_INF_RECT, FZ_MIN_INF_RECT, FZ_MAX_INF_RECT, FZ_MAX_INF_RECT};
const fz_rect fz_invalid_rect = {0, 0, -1, -1};
const fz_irect fz_invalid_irect = {0, 0, -1, -1};
const fz_rect fz_unit_rect = {0, 0, 1, 1};
const fz_irect fz_unit_bbox = {0, 0, 1, 1};
}

namespace eukolia {

namespace {
// Local shorthands so the ported code reads like light-pdf's. These deliberately
// do NOT reuse the global fz_empty_rect / fz_identity names: those come from the
// MuPDF headers and, because they are plain globals, a translation unit that
// forgets to define them for itself silently gets a *different value* than the
// one this port was written against.
const fz_matrix& kIdentity = fz_identity;
const fz_rect& kEmptyRect = fz_empty_rect;
const fz_irect& kEmptyIrect = fz_empty_irect;

/**
 * A fingerprint of the file's *contents*, not its metadata.
 *
 * A rebuild that produces identical bytes is the common case: building twice,
 * saving a comment that does not reach the PDF, or a build whose only real change
 * was in the log. Timestamps cannot tell that apart from a real edit, and neither
 * can size, so the decision to re-parse has to be made on content.
 *
 * 64-bit FNV-1a is enough. This is not a security boundary and not a cache key
 * that outlives the open document: it only answers "is the file byte-for-byte what
 * I already have open", where a collision means one skipped re-parse of the file
 * the user is already looking at. It runs at roughly a gigabyte a second, so a
 * 1 MB PDF costs about a millisecond against the ~150 ms a reopen spends
 * rasterising pages.
 */
uint64_t FingerprintFile(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return 0;  // 0 means "unreadable", which never equals a real fingerprint
    uint64_t hash = 1469598103934665603ull;  // FNV-1a 64 offset basis
    unsigned char buffer[65536];
    size_t n = 0;
    while ((n = std::fread(buffer, 1, sizeof(buffer), f)) > 0) {
        for (size_t i = 0; i < n; i++) {
            hash ^= static_cast<uint64_t>(buffer[i]);
            hash *= 1099511628211ull;  // FNV-1a 64 prime
        }
    }
    const bool failed = std::ferror(f) != 0;
    std::fclose(f);
    return failed ? 0 : hash;
}
}  // namespace

// MuPDF's fz_font_name() and pdf_font_desc_from_font() are not exported by this
// build, but `struct fz_font` is public and its `name` field is a NUL-terminated
// 32-byte face name, so it can be read directly. light-pdf reads the same name
// through pdf_font_desc for its font list.
std::string FontNameOf(fz_context* ctx, fz_font* font) {
    (void)ctx;
    if (!font) return {};
    return std::string(font->name);
}

namespace {

// light-pdf's PdfCleanStringInPlace() replacement: strip the control characters
// that PDF outline titles and Info values sometimes carry.
std::string CleanPdfString(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (unsigned char c : in) {
        if (c == '\r' || c == '\n' || c == '\t') {
            out.push_back(' ');
        } else if (c < 0x20 || c == 0x7f) {
            continue;
        } else {
            out.push_back(static_cast<char>(c));
        }
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// Construction / context management
// ---------------------------------------------------------------------------

// light-pdf: EngineMupdf's per-FZ_LOCK-index SRW locks handed to mupdf through
// fz_locks_ctx. Never held across our own code for long.
struct FzLocks {
    std::mutex locks[FZ_LOCK_MAX];
};

namespace {

void FzLockCallback(void* user, int lock) {
    static_cast<FzLocks*>(user)->locks[lock].lock();
}

void FzUnlockCallback(void* user, int lock) {
    static_cast<FzLocks*>(user)->locks[lock].unlock();
}

void FzPrintCallback(void* user, const char* message) {
    auto* engine = static_cast<PdfEngine*>(user);
    if (engine && message) {
        engine->PushDiagnostic(message);
    }
}

std::mutex g_mupdfInitMutex;
bool g_mupdfHandlersRegistered = false;

}  // namespace

// Handles a caught mupdf error and leaves the context's error stack balanced.
//
// Every fz_catch MUST either call fz_caught() itself or report the error through
// fz_report_error(), which calls fz_caught() internally. Neither
// `fz_caught_message()` nor `fz_rethrow_if()` pops the try-frame:
//
//   * fz_rethrow_if(ctx, FZ_ERROR_SYSTEM) only decides whether to unwind
//     further. When it returns (the common case) the frame is still on the
//     stack, so the next fz_try pushes one level deeper and every catch leaks a
//     slot;
//   * TakeCaughtMessage(ctx).c_str() merely reads ctx->error.message and does not touch
//     the stack at all. A catch block that only copies the message out and then
//     returns leaves the frame behind for good.
//
// Leaked frames accumulate until fz_drop_context() trips
// `assert(ctx->error.top == ctx->error.stack_base)` -- a modal abort dialog in
// the debug DLL that ships in resources/native, which takes the whole app down.
//
// Consuming the error keeps the stack balanced so the worker survives a damaged
// page forever. An out-of-memory condition is still surfaced; it fails one
// request rather than killing the process, which is the right trade for a
// viewer.
void ReportCaughtError(fz_context* ctx) {
    const int code = fz_caught(ctx);
    fz_report_error(ctx);
    if (code == FZ_ERROR_SYSTEM) {
        // fz_log_error is not exported by this MuPDF build; fz_warn reaches the
        // same callback without throwing.
        fz_warn(ctx, "eukolia-pdf: out of memory; the request was abandoned");
    }
}

/**
 * Consumes a caught error and returns its message.
 *
 * Use this instead of fz_caught_message() in an fz_catch block: it pops the
 * try-frame as well as reading the text, so the error stack stays balanced.
 */
std::string TakeCaughtMessage(fz_context* ctx) {
    (void)fz_caught(ctx);  // pops the try-frame
    // Read the message directly: fz_caught_message() would be equivalent here but
    // the struct field is public and keeps this helper self-contained.
    const char* message = ctx->error.message;
    return std::string(message ? message : "unknown mupdf error");
}

/**
 * light-pdf's Windows system-font loader, which is compiled *into* the vendored
 * `libmupdf.dll` (`References/light-pdf/ext/mupdf_load_system_font.c` — the file's
 * own header says it lives in the library "to avoid issues related to crossing
 * .dll boundaries") and exported by name. There is no header for it: it is not
 * part of MuPDF's API, which is why it is declared here rather than included.
 *
 * Installing it is what makes a *non-embedded* font resolve the way light-pdf
 * resolves it. Without a loader, `fz_load_system_font` returns NULL for every
 * name and MuPDF substitutes its own built-in base-14 clones; with it, the face
 * comes from the Windows font directory — the same faces, at the same hinted
 * outlines, that the reference draws. Embedded fonts (which is what a LaTeX
 * build produces) never reach this path, and CJK documents that reference a
 * system face without embedding it are the ones that gain the most: the loader
 * enumerates the CJK and fallback families too.
 */
extern "C" void install_load_windows_font_funcs(fz_context* ctx);

PdfEngine::PdfEngine() : locks_(new FzLocks()) {
    fz_locks_context lockCtx;
    lockCtx.user = locks_.get();
    lockCtx.lock = FzLockCallback;
    lockCtx.unlock = FzUnlockCallback;

    ctx_ = fz_new_context(nullptr, &lockCtx, FZ_STORE_DEFAULT);
    if (!ctx_) {
        return;
    }
    fz_set_warning_callback(ctx_, FzPrintCallback, this);
    fz_set_error_callback(ctx_, FzPrintCallback, this);

    // `install_load_windows_font_funcs` installs the callbacks on the context it
    // is given, and that is enough for every thread: `fz_clone_context` memcpy's
    // the whole context (`mupdf/source/fitz/context.c`), so each worker thread's
    // clone (`Ctx()`) inherits the loader along with everything else.
    // Measured with and without this call on the same document (`/BaseFont
    // /SimSun`, not embedded): with it the face comes from the Windows font
    // directory, without it every unresolvable name renders from one built-in
    // substitute. See `tests/pdf/fontResolution.test.ts`.
    install_load_windows_font_funcs(ctx_);

    {
        std::lock_guard<std::mutex> guard(g_mupdfInitMutex);
        if (!g_mupdfHandlersRegistered) {
            // Must run on a live context: mupdf's registration touches ctx.
            fz_register_document_handlers(ctx_);
            g_mupdfHandlersRegistered = true;
        }
    }
}

PdfEngine::~PdfEngine() {
    CloseDocument();

    // Release the per-thread context clones. Every worker thread has been joined
    // by the time this runs (RenderCache::Stop and Worker::StopTaskThread), so no
    // thread can still be using one.
    {
        std::lock_guard<std::mutex> guard(clonesMutex_);
        for (auto& entry : clones_) {
            if (entry.second && entry.second != ctx_) {
                fz_drop_context(entry.second);
            }
        }
        clones_.clear();
    }

    if (ctx_) {
        // Shutdown is the one place an error may still be pending with nobody
        // left to consume it. fz_drop_context() asserts
        // `ctx->error.top == ctx->error.stack_base`, and in the debug DLL that
        // ships in resources/native an assert is a modal abort dialog that takes
        // the whole app down. So the error state is cleared unconditionally
        // before the drop: `fz_error_context` is part of the public `fz_context`
        // struct, and force-resetting `top` to `stack_base` is exactly what a
        // balanced fz_catch would have left behind. The stack slots are jmp_buf
        // storage and own nothing, so discarding them leaks no memory.
        //
        // This is belt-and-braces: ReportCaughtError() above is the real fix and
        // keeps the stack balanced during normal operation.
        ctx_->error.errcode = FZ_ERROR_NONE;
        ctx_->error.errnum = 0;
        ctx_->error.top = ctx_->error.stack_base;

        fz_context* ctx = ctx_;
        ctx_ = nullptr;
        // Deliberately NOT wrapped in fz_try/fz_catch.
        //
        // `fz_try` pushes a frame onto the very error stack that
        // `fz_drop_context` asserts is empty, so wrapping the drop guarantees the
        // assertion fires — which is what produced the modal
        // "Assertion failed: ctx->error.top == ctx->error.stack_base" dialog from
        // the debug libmupdf.dll on every shutdown. The error state is already
        // cleared above, so the drop has nothing to complain about, and a drop
        // that throws has no meaningful recovery anyway.
        fz_drop_context(ctx);
    }
}

fz_context* PdfEngine::BaseCtx() const {
    return ctx_;
}

fz_context* PdfEngine::Ctx() {
    if (!ctx_) return nullptr;
    const std::thread::id id = std::this_thread::get_id();
    std::lock_guard<std::mutex> guard(clonesMutex_);
    auto it = clones_.find(id);
    if (it != clones_.end()) {
        return it->second;
    }
    fz_context* clone = nullptr;
    // fz_var() is mandatory for anything assigned inside fz_try and read after
    // fz_catch: mupdf throws with longjmp, and a value held only in a register
    // is not restored when the stack unwinds.
    fz_var(clone);
    fz_try(ctx_) {
        clone = fz_clone_context(ctx_);
    }
    fz_catch(ctx_) {
        fz_report_error(ctx_);
    }
    if (clone) {
        fz_set_warning_callback(clone, FzPrintCallback, this);
        fz_set_error_callback(clone, FzPrintCallback, this);
        clones_[id] = clone;
    }
    return clone ? clone : ctx_;
}

void PdfEngine::PushDiagnostic(const std::string& message) {
    std::lock_guard<std::mutex> guard(diagnosticsMutex_);
    if (diagnostics_.size() > 64) return;
    std::string msg = message;
    while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r')) {
        msg.pop_back();
    }
    if (!msg.empty()) diagnostics_.push_back(std::move(msg));
}

std::vector<std::string> PdfEngine::TakeDiagnostics() {
    std::lock_guard<std::mutex> guard(diagnosticsMutex_);
    std::vector<std::string> out;
    out.swap(diagnostics_);
    return out;
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

void PdfEngine::CloseDocument() {
    std::lock_guard<std::recursive_mutex> renderLock(renderMutex_);
    std::lock_guard<std::recursive_mutex> lock(stateMutex_);
    if (ctx_) {
        // Display lists hold references to decoded images owned by the document,
        // so they must go first.
        for (auto& page : pages_) {
            if (page.displayList) {
                fz_drop_display_list(ctx_, page.displayList);
                page.displayList = nullptr;
            }
            if (page.page) {
                fz_drop_page(ctx_, page.page);
                page.page = nullptr;
            }
        }
    }
    pages_.clear();
    if (ctx_ && outline_) {
        fz_drop_outline(ctx_, outline_);
    }
    outline_ = nullptr;
    if (ctx_ && doc_) {
        fz_drop_document(ctx_, doc_);
    }
    doc_ = nullptr;
    pdf_ = nullptr;
    path_.clear();
    pageCount_ = 0;
    opened_ = false;
    needsPassword_ = false;
    metadata_.clear();
    // No document, nothing to recognise a future Open() against.
    contentFingerprint_ = 0;
}

bool PdfEngine::Open(const std::string& path, const std::string& password, std::string& error) {
    std::lock_guard<std::recursive_mutex> renderLock(renderMutex_);
    std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
    lastOpenUnchanged_ = false;
    /*
     * Nothing to do if this is the document already open, byte for byte.
     *
     * A LaTeX rebuild rewrites the PDF at the path that is already loaded, and the
     * pane answers every finished build by asking for it again. When the bytes are
     * identical -- building twice, saving something that never reaches the PDF, a
     * build that only changed the log -- the expensive part of that request is
     * pure waste: CloseDocument() drops every page, every display list and the
     * whole render cache, and the reopen then re-parses 242 pages and re-rasterises
     * the visible ones from scratch. Measured on a 242-page document that is
     * ~150 ms, almost all of it rasterisation, and it is what a reader sees as the
     * preview flickering on a build that changed nothing.
     *
     * The fingerprint is what makes this safe: a real edit changes the bytes, so a
     * real edit takes the normal path. Checking it costs about a millisecond.
     */
    if (opened_ && !path.empty() && path == path_ && contentFingerprint_ != 0) {
        const uint64_t fingerprint = FingerprintFile(path);
        if (fingerprint != 0 && fingerprint == contentFingerprint_) {
            lastOpenUnchanged_ = true;
            return true;
        }
    }

    const uint64_t openFingerprint = FingerprintFile(path);
    std::lock_guard<std::recursive_mutex> lock(stateMutex_);

    /*
     * Stage the parse against a backup, and only replace the document once the new
     * one has fully arrived.
     *
     * CloseDocument() used to run at the top of this function, which meant a
     * *failed* open had already destroyed the document on screen. That is the worst
     * possible moment for it: a LaTeX build rewrites the PDF in place, the pane
     * re-opens on every finished build, and a read that lands mid-write fails -- so
     * the pane was left holding no document at all, and the next build had nothing
     * to keep on screen. light-pdf does not have this failure because
     * `ReloadDocument` builds the replacement controller first and only calls
     * `ReplaceDocumentInCurrentTab` once it exists (LightPDF.cpp:1967-1995).
     *
     * Holding the backup costs nothing: the page slots are value types and the
     * MuPDF objects are pointers, so this is a handful of moves. Every failure path
     * below either reinstates it or drops it -- there is no path that leaves both
     * documents alive.
     */
    std::string oldPath = std::move(path_);
    std::vector<PageSlot> oldPages = std::move(pages_);
    const int oldPageCount = pageCount_;
    const bool oldOpened = opened_;
    const bool oldNeedsPassword = needsPassword_;
    fz_outline* oldOutline = outline_;
    std::map<std::string, std::string> oldMetadata = std::move(metadata_);
    const uint64_t oldFingerprint = contentFingerprint_;
    fz_document* oldDoc = doc_;
    pdf_document* oldPdf = pdf_;

    path_.clear();
    pages_.clear();
    pageCount_ = 0;
    opened_ = false;
    needsPassword_ = false;
    outline_ = nullptr;
    metadata_.clear();
    contentFingerprint_ = 0;
    doc_ = nullptr;
    pdf_ = nullptr;

    /** Put the document that was on screen back, and release the staged one. */
    const auto restoreOld = [&] {
        CloseDocument();  // frees whatever the failed parse left behind
        path_ = std::move(oldPath);
        pages_ = std::move(oldPages);
        pageCount_ = oldPageCount;
        opened_ = oldOpened;
        needsPassword_ = oldNeedsPassword;
        outline_ = oldOutline;
        metadata_ = std::move(oldMetadata);
        contentFingerprint_ = oldFingerprint;
        doc_ = oldDoc;
        pdf_ = oldPdf;
    };
    /** Keep the staged document, and release the one it replaces. */
    const auto commitNew = [&] {
        for (auto& page : oldPages) {
            if (!ctx_) break;
            if (page.displayList) fz_drop_display_list(ctx_, page.displayList);
            if (page.page) fz_drop_page(ctx_, page.page);
        }
        oldPages.clear();
        if (oldOutline && ctx_) fz_drop_outline(ctx_, oldOutline);
        if (oldDoc && ctx_) fz_drop_document(ctx_, oldDoc);
    };

    bool parsed = false;
    try {
        parsed = ParseIntoMembersLocked(path, password, openFingerprint, error);
    } catch (...) {
        restoreOld();
        throw;
    }
    if (parsed) {
        commitNew();
        return true;
    }

    /*
     * A password-protected document is the one failure worth keeping: the caller is
     * told `needsPassword` and retries with a password, and that flag comes from the
     * engine, so the staged document has to be the one the engine holds. Nothing on
     * screen is lost either way -- a protected file has no pages to show.
     */
    if (needsPassword_ && !oldOpened) {
        commitNew();
        return false;
    }

    restoreOld();
    return false;
}

/**
 * Parse `path` into the engine's members. The caller owns the transaction.
 *
 * Split out of `Open` deliberately: everything below the entry checks is the
 * "build the new document" half, and keeping it in one piece is what lets `Open`
 * stage it against a backup instead of having to interleave restore logic with the
 * parse.
 */
bool PdfEngine::ParseIntoMembersLocked(const std::string& path, const std::string& password,
                                      uint64_t openFingerprint, std::string& error) {
    if (!ctx_) {
        error = "MuPDF context could not be created";
        return false;
    }
    if (path.empty()) {
        error = "empty document path";
        return false;
    }

    bool failed = false;
    fz_buffer* snapshot = nullptr;
    fz_stream* stream = nullptr;
    fz_var(failed);
    fz_var(snapshot);
    fz_var(stream);
    fz_try(ctx_) {
        // Own immutable bytes. A lazy file-backed document becomes invalid as
        // soon as the compiler truncates its file, even if rollback restores it.
        snapshot = fz_read_file(ctx_, path.c_str());
        unsigned char* bytes = nullptr;
        const size_t size = fz_buffer_storage(ctx_, snapshot, &bytes);
        uint64_t fingerprint = 1469598103934665603ull;
        for (size_t i = 0; i < size; ++i) {
            fingerprint ^= bytes[i];
            fingerprint *= 1099511628211ull;
        }
        if (fingerprint != openFingerprint)
            fz_throw(ctx_, FZ_ERROR_FORMAT, "PDF changed while reading snapshot");
        // Do not let MuPDF's repair mode commit a compiler's partial output.
        const size_t tail = size > 1024 ? size - 1024 : 0;
        bool complete = false;
        for (size_t i = tail; i + 5 <= size; ++i)
            if (std::memcmp(bytes + i, "%%EOF", 5) == 0) complete = true;
        if (!complete) fz_throw(ctx_, FZ_ERROR_FORMAT, "unexpected EOF in PDF snapshot");
        stream = fz_open_buffer(ctx_, snapshot);
        doc_ = fz_open_document_with_stream(ctx_, "application/pdf", stream);
    }
    fz_always(ctx_) {
        fz_drop_stream(ctx_, stream);
        fz_drop_buffer(ctx_, snapshot);
    }
    fz_catch(ctx_) {
        error = TakeCaughtMessage(ctx_);
        failed = true;
    }
    if (failed || !doc_) {
        if (error.empty()) error = "MuPDF could not open the document";
        CloseDocument();
        return false;
    }

    path_ = path;
    bool protectedDocument = false;
    fz_var(protectedDocument);
    fz_try(ctx_) { protectedDocument = fz_needs_password(ctx_, doc_) != 0; }
    fz_catch(ctx_) { error = TakeCaughtMessage(ctx_); failed = true; }
    if (failed) { CloseDocument(); return false; }
    if (protectedDocument) {
        needsPassword_ = true;
        bool authenticated = false;
        fz_var(authenticated);
        if (!password.empty()) {
            fz_try(ctx_) {
                authenticated = fz_authenticate_password(ctx_, doc_, password.c_str()) != 0;
            }
            fz_catch(ctx_) {
                error = TakeCaughtMessage(ctx_);
            }
        }
        if (!authenticated) {
            // The document stays open so the caller can retry with a password,
            // but no page data is exposed.
            if (error.empty()) error = "document is password protected";
            return false;
        }
        needsPassword_ = false;
    }

    pdf_ = pdf_specifics(ctx_, doc_);
    int pageCount = 0;
    fz_var(pageCount);
    fz_try(ctx_) {
        pageCount = fz_count_pages(ctx_, doc_);
    }
    fz_catch(ctx_) {
        error = TakeCaughtMessage(ctx_);
        CloseDocument();
        return false;
    }
    if (pageCount <= 0) {
        error = "document contains no pages";
        CloseDocument();
        return false;
    }
    pageCount_ = pageCount;
    // light-pdf: FinishLoading() pre-computes every page's geometry with
    // pdf_page_obj_transform so layout and rendering never have to touch the
    // page tree again. Same here, including the 612x792 fallback.
    //
    // `page_ctm` from pdf_page_obj_transform already does the two things that are
    // easy to get wrong, and reading it out of mupdf's own source is what makes
    // the reported coordinates line up with the drawn content:
    //
    //   * the returned rect is the CropBox (fitz page space: 72 dpi, origin at
    //     the top-left of the crop box, y descending), not the raw MediaBox, and
    //   * the matrix also carries the page's /Rotate and a translation that moves
    //     the crop box origin to (0, 0).
    //
    // So a page with a non-zero MediaBox/CropBox origin needs no extra fix-up: it
    // is baked into pageCtm. light-pdf keeps the same split (PageMediabox() plus
    // a separately computed view CTM).
    pages_.resize(static_cast<size_t>(pageCount_));
    for (int i = 0; i < pageCount_; i++) {
        fz_var(i);
        PageSlot& slot = pages_[static_cast<size_t>(i)];
        slot.pageNo = i + 1;
        slot.mediaBox = RectF::FromXY(0, 0, 612, 792);
        slot.pageCtm = kIdentity;
        slot.contentToPage = kIdentity;
        if (pdf_) {
            fz_rect mbox = kEmptyRect;
            fz_matrix pageCtm = kIdentity;
            fz_var(mbox);
            fz_var(pageCtm);
            fz_try(ctx_) {
                pdf_obj* pageRef = pdf_lookup_page_obj(ctx_, pdf_, i);
                pdf_page_obj_transform(ctx_, pageRef, &mbox, &pageCtm);
                slot.pageRotate = NormalizeRotation(pdf_to_int(ctx_, pdf_dict_get_inheritable(ctx_, pageRef, PDF_NAME(Rotate))));
            }
            fz_catch(ctx_) {
                error = TakeCaughtMessage(ctx_);
                failed = true;
            }
            if (failed) { CloseDocument(); return false; }
            if (!fz_is_empty_rect(mbox)) {
                /**
                 * The page box is the rectangle the *content* occupies, and that
                 * is the rotated one: `fz_run_page` and
                 * `fz_new_display_list_from_page` apply the page's own `/Rotate`
                 * (`pdf_run_page_contents_with_usage_imp` does
                 * `ctm = fz_concat(page_ctm, ctm)`), so a `/Rotate 90` A4 page
                 * spans 792x612 in the space every other coordinate the worker
                 * reports — text boxes, links, selection rectangles — is in.
                 *
                 * Storing the *un*rotated CropBox here made the clip, the pixmap
                 * and the text extractor's page box disagree with the content
                 * that had already been rotated: a `/Rotate 90` page rendered
                 * blank (its content fell outside the unrotated clip), a
                 * `/Rotate 270` page lost a strip of itself, both came back with
                 * the wrong aspect, and the text layer's boxes collapsed to zero
                 * because the glyphs sat outside the page box it was built
                 * against. This is what `pdf_bound_page` itself returns
                 * (`pdf_page_transform` then `fz_transform_rect`).
                 */
                mbox = fz_transform_rect(mbox, pageCtm);
                slot.mediaBox = RectF::FromXY(0, 0, mbox.x1 - mbox.x0, mbox.y1 - mbox.y0);
            }
            slot.pageCtm = pageCtm;
            slot.contentToPage = fz_invert_matrix(pageCtm);
            if (fz_matrix_expansion(slot.contentToPage) <= 0) {
                slot.contentToPage = kIdentity;
            }
            // /Rotate is already applied inside pageCtm; pageRotate only records
            // it for diagnostics and is not applied a second time.
        }
    }

    fz_try(ctx_) {
        outline_ = fz_load_outline(ctx_, doc_);
    }
    fz_catch(ctx_) {
        // Outlines are not critical: light-pdf swallows the same failure so a
        // broken outline never prevents a document from opening.
        fz_report_error(ctx_);
        outline_ = nullptr;
    }

    LoadMetadataLocked();
    opened_ = true;
    /*
     * Fingerprint the file as it was *before* the parse, not after.
     *
     * Taking it here would let a writer that lands between the last page read and
     * this line pair a hash of the NEW bytes with a document parsed from the OLD
     * ones -- and the next Open() would then see a matching hash and keep a stale
     * document forever. Hashing first inverts the failure: if the file changed
     * mid-parse, the stored hash describes bytes the document does not match, so
     * the next Open() sees a difference and re-reads. Wrong in the direction that
     * self-corrects.
     */
    contentFingerprint_ = openFingerprint;
    return true;
}

// fz_lookup_metadata() takes a caller buffer and returns the length written.
// Isolated in its own function so the fz_try frame has no other live locals.
namespace {

std::string LookupMupdfMetadata(fz_context* ctx, fz_document* doc, const char* key) {
    char buf[512];
    buf[0] = 0;
    std::string result;
    fz_var(buf);
    fz_try(ctx) {
        if (fz_lookup_metadata(ctx, doc, key, buf, sizeof(buf)) > 0) {
            result = CleanPdfString(std::string(buf));
        }
    }
    fz_catch(ctx) {
        // Must CONSUME the error. fz_catch only runs when there is a pending
        // error, and on that path the try-frame has already been pushed, so a
        // return from inside this block (or any path that does not reach
        // fz_caught) leaves the frame behind -- one leaked error-stack slot per
        // failure, which is what eventually trips fz_drop_context's assert.
        ReportCaughtError(ctx);
    }
    return result;
}

}  // namespace

void PdfEngine::LoadMetadataLocked() {
    metadata_.clear();
    if (!ctx_ || !doc_) return;

    // light-pdf reads the Info dictionary directly rather than relying on
    // fz_lookup_metadata, which only knows the standard keys.
    auto readString = [&](pdf_obj* dict, const char* key) -> std::string {
        if (!dict) return {};
        std::string result;
        fz_try(ctx_) {
            pdf_obj* value = pdf_dict_gets(ctx_, dict, key);
            if (pdf_is_string(ctx_, value)) {
                // fz_malloc'd NUL-terminated UTF-8; MuPDF has already handled the
                // PDFDocEncoding/UTF-16BE BOM cases.
                char* utf8 = pdf_new_utf8_from_pdf_string_obj(ctx_, value);
                if (utf8) {
                    result = CleanPdfString(std::string(utf8));
                    fz_free(ctx_, utf8);
                }
            }
        }
        fz_catch(ctx_) {
            ReportCaughtError(ctx_);
        }
        return result;
    };

    pdf_obj* info = nullptr;
    if (pdf_) {
        fz_try(ctx_) {
            // Resolve /Info through the trailer so that both direct and indirect
            // Info dictionaries work.
            pdf_obj* trailer = pdf_trailer(ctx_, pdf_);
            info = pdf_dict_gets(ctx_, trailer, "Info");
        }
        fz_catch(ctx_) {
            ReportCaughtError(ctx_);
            info = nullptr;
        }
    }

    struct Key {
        const char* pdfKey;
        const char* outKey;
    };
    static const Key kKeys[] = {
        {"Title", "title"},        {"Author", "author"},     {"Subject", "subject"},
        {"Keywords", "keywords"},  {"Creator", "creator"},   {"Producer", "producer"},
        {"CreationDate", "creationDate"}, {"ModDate", "modDate"},
    };
    for (const Key& key : kKeys) {
        const std::string value = readString(info, key.pdfKey);
        if (!value.empty()) {
            metadata_[key.outKey] = value;
        }
    }

    // Fall back to MuPDF's own metadata lookup for the standard keys the Info
    // dictionary may be missing. The lookup happens in a helper so that no loop
    // variable is live across fz_try/fz_catch (mupdf throws with longjmp).
    struct Fallback {
        const char* mupdfKey;
        const char* outKey;
    };
    static const Fallback kFallbacks[] = {
        {FZ_META_INFO_TITLE, "title"},     {FZ_META_INFO_AUTHOR, "author"},
        {FZ_META_INFO_SUBJECT, "subject"}, {FZ_META_FORMAT, "format"},
        {FZ_META_ENCRYPTION, "encryption"},
    };
    for (size_t fallbackIndex = 0; fallbackIndex < sizeof(kFallbacks) / sizeof(kFallbacks[0]); fallbackIndex++) {
        const Fallback& fb = kFallbacks[fallbackIndex];
        if (metadata_.count(fb.outKey)) continue;
        const std::string value = LookupMupdfMetadata(ctx_, doc_, fb.mupdfKey);
        if (!value.empty()) {
            metadata_[fb.outKey] = value;
        }
    }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

PdfEngine::PageSlot* PdfEngine::GetPageLocked(fz_context* ctx, int pageIndex) {
    if (pageIndex < 0 || pageIndex >= pageCount_) return nullptr;
    PageSlot& slot = pages_[static_cast<size_t>(pageIndex)];
    if (!slot.page) {
        fz_try(ctx) {
            slot.page = fz_load_page(ctx, doc_, pageIndex);
        }
        fz_catch(ctx) {
            fz_report_error(ctx);
            slot.page = nullptr;
        }
    }
    return slot.page ? &slot : nullptr;
}

mupdf::PageView PdfEngine::PageView_(int pageIndex, float scale, int userRotate) {
    mupdf::PageView view;
    std::lock_guard<std::recursive_mutex> lock(stateMutex_);
    if (!opened_ || pageIndex < 0 || pageIndex >= pageCount_) return view;
    const PageSlot& slot = pages_[static_cast<size_t>(pageIndex)];
    view.pageIndex = pageIndex;
    // The page's displayed rectangle in fitz page space: 72 dpi, origin at the
    // top-left of the CropBox, y descending. This is what every coordinate the
    // worker reports is expressed in.
    //
    // It is deliberately NOT rotated by the page's own /Rotate, and neither is the
    // raster: one coordinate space has to hold for the rendered pixels, the text
    // boxes, the links and the selection rectangles, and the unrotated CropBox is
    // the one the content, the text extraction and the display list all share.
    // Reading rotation is a *view* concern and is applied by the viewer, as a
    // transform on the page sheet — light-pdf instead folds /Rotate into the view
    // CTM and works in display space, which is self-consistent in exactly the same
    // way. Mixing the two is what rotates a page twice.
    view.mediaBox = RectF::FromXY(0, 0, slot.mediaBox.dx, slot.mediaBox.dy);
    view.pageRotate = slot.pageRotate;
    view.userRotate = NormalizeRotation(userRotate);
    view.scale = scale > 0 ? scale : 1.0f;
    // pageCtm maps fitz page space -> PDF user space, so its inverse maps content
    // space -> fitz page space. Running a device with that matrix (at resolution
    // 1) makes every callback in the PDF interpreter report coordinates that are
    // already in fitz page space, which is the space the worker exposes.
    view.pageCtm = slot.pageCtm;
    view.contentToPage = slot.contentToPage;
    // `userCtm` is the reader's view transform and nothing else. The page's own
    // /Rotate is applied to the *content* by `fz_run_page` /
    // `fz_new_display_list_from_page`, so folding `pageCtm` in here as well would
    // rotate the page twice — a /Rotate 180 page then renders exactly as if it had
    // no /Rotate at all (upside down), and a /Rotate 90 page is rotated out of its
    // own pixmap and comes back blank. `ctm` keeps the full composition because it
    // is what maps a page-space point (text boxes, link rects) into the bitmap.
    view.userCtm = fz_concat(fz_scale(view.scale, view.scale), fz_rotate(static_cast<float>(view.userRotate)));
    view.ctm = fz_concat(slot.pageCtm, view.userCtm);
    return view;
}

RectF PdfEngine::MediaBox(int pageIndex) const {
    std::lock_guard<std::recursive_mutex> lock(stateMutex_);
    if (pageIndex < 0 || pageIndex >= pageCount_) return RectF{};
    return pages_[static_cast<size_t>(pageIndex)].mediaBox;
}

// light-pdf: PageContentBox(). Runs a bbox device over the page's display list
// and intersects the result with the MediaBox. Used by the viewer to trim
// whitespace; the worker only needs it on request.
RectF PdfEngine::PageContentBox(int pageIndex) {
    std::lock_guard<std::recursive_mutex> lock(renderMutex_);
    fz_context* ctx = Ctx();
    if (!ctx) return RectF{};

    fz_display_list* list = GetOrBuildDisplayList(ctx, pageIndex);
    if (!list) return RectF{};

    RectF result{};
    {
        std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
        result = pages_[static_cast<size_t>(pageIndex)].mediaBox;
    }

    fz_rect pageRect = kEmptyRect;
    fz_rect bbox = kEmptyRect;
    fz_device* dev = nullptr;
    fz_var(dev);
    // `volatile` because this is written inside `fz_try` and read after it:
    // MuPDF throws with longjmp, so a non-volatile local modified in the try
    // block is indeterminate once the catch handler runs.
    volatile bool haveSlot = false;
    fz_try(ctx) {
        PageSlot* slot = GetPageLocked(ctx, pageIndex);
        if (slot) {
            haveSlot = true;
            pageRect = fz_bound_page(ctx, slot->page);
            dev = fz_new_bbox_device(ctx, &bbox);
            fz_run_display_list(ctx, list, dev, kIdentity, pageRect, nullptr);
            fz_close_device(ctx, dev);
        }
    }
    fz_always(ctx) {
        if (dev) fz_drop_device(ctx, dev);
        fz_drop_display_list(ctx, list);
    }
    fz_catch(ctx) {
        fz_report_error(ctx);
        return result;
    }

    // Returning from inside `fz_try` would skip `fz_always` and leak the error
    // frame that `fz_try` pushed, so the "no such page" case is handled here.
    if (!haveSlot) {
        return result;
    }

    if (fz_is_infinite_rect(bbox) || fz_is_empty_rect(bbox)) {
        return result;
    }
    return ToRectF(bbox).Intersect(result);
}

fz_display_list* PdfEngine::GetOrBuildDisplayList(fz_context* ctx, int pageIndex) {
    std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
    PageSlot* slot = GetPageLocked(ctx, pageIndex);
    if (!slot) return nullptr;

    if (!slot->displayList) {
        fz_display_list* list = nullptr;
        fz_var(list);
        fz_try(ctx) {
            // The "View" rendering (no Print usage, no hideAnnotations) is what
            // fz_new_display_list_from_page produces, so it is safe to cache and
            // replay (light-pdf: GetOrBuildPageDisplayList).
            list = fz_new_display_list_from_page(ctx, slot->page);
        }
        fz_catch(ctx) {
            fz_report_error(ctx);
            list = nullptr;
        }
        slot->displayList = list;
    }
    if (!slot->displayList) return nullptr;
    return fz_keep_display_list(ctx, slot->displayList);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

mupdf::Pixmap* PdfEngine::RenderPage(const mupdf::RenderPageArgs& args) {
    fz_context* ctx = Ctx();
    if (!ctx || !args.view) return nullptr;

    // Serialised: display-list replay can decode shared image objects, and
    // mupdf's image store races on concurrent decode of the same image
    // (light-pdf holds its engine-wide renderLock for exactly this reason).
    std::lock_guard<std::recursive_mutex> lock(renderMutex_);

    fz_display_list* list = GetOrBuildDisplayList(ctx, args.pageIndex);
    if (!list) return nullptr;

    // `args.clip` is in fitz page space, which is the space fz_run_page() expects
    // for its `area` argument, so no conversion is needed.
    fz_rect clipRect = kEmptyRect;
    if (args.clip) {
        clipRect = ToFzRect(*args.clip);
    } else {
        clipRect = ToFzRect(args.view->mediaBox);
    }
    const fz_rect pageSpan = ToFzRect(args.view->mediaBox);

    fz_matrix pageToDevice = kIdentity;
    fz_irect ibounds = kEmptyIrect;
    {
        std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
        // `userCtm`, NOT `ctm`: the page's own /Rotate is already applied to the
        // content this list holds (`fz_new_display_list_from_page` runs the page
        // through the page transform), so it must not be applied a second time
        // here. light-pdf keeps the same split — `EngineMupdf.cpp:4128` builds
        // `ctm = viewctm(page, zoom, rotation)` from the *rotated* page bounds for
        // the draw device, and replays the list with `fz_identity` (`:4176`).
        //
        // Folding `pageCtm` in here as well is what made a /Rotate 180 page render
        // exactly like a /Rotate 0 one — the two 180s cancelled — and a /Rotate 90
        // page rotate straight out of its own pixmap and come back blank.
        pageToDevice = args.view->userCtm;
        ibounds = fz_round_rect(fz_transform_rect(clipRect, pageToDevice));
    }

    const int width = ibounds.x1 - ibounds.x0;
    const int height = ibounds.y1 - ibounds.y0;
    if (width <= 0 || height <= 0) {
        fz_drop_display_list(ctx, list);
        return nullptr;
    }
    // Guard against absurd allocations from a bad zoom/clip combination.
    constexpr int kMaxDimension = 32000;
    if (width > kMaxDimension || height > kMaxDimension) {
        fz_drop_display_list(ctx, list);
        return nullptr;
    }

    // The pixmap is anchored at (0,0) and the device matrix carries the origin
    // shift, which is how mupdf itself does it in fz_new_pixmap_from_page*(): the
    // draw device draws at the device coordinates its transform produces, so the
    // pixmap origin must coincide with ibounds' origin.
    const fz_matrix deviceCtm =
        fz_concat(pageToDevice, fz_translate(-static_cast<float>(ibounds.x0), -static_cast<float>(ibounds.y0)));
    const fz_irect pixelBox = fz_make_irect(0, 0, width, height);

    fz_set_aa_level(ctx, 8);

    mupdf::Pixmap* out = nullptr;
    fz_pixmap* pix = nullptr;
    fz_device* dev = nullptr;
    const bool useAlpha = args.alpha;
    fz_colorspace* colorspace = nullptr;
    bool failed = false;
    std::string failure;

    fz_var(pix);
    fz_var(dev);

    fz_try(ctx) {
        /**
         * RGB, not BGR: the only consumer of these pixels is a browser canvas, whose
         * `ImageData` is RGBA. Rendering BGR made the renderer swap red and blue over
         * every pixel of every page on the main thread — 2.5 million pixels for a
         * page-width fit in a wide pane, measured as a 35–49 ms frame each time a
         * page arrived during a scroll. light-pdf's own choice of BGR is a Windows
         * DIB convention (its `EngineMupdf.cpp` converts RGB to BGR for GDI); it
         * means nothing to a canvas, so this is where the port stops following it.
         */
        colorspace = args.gray ? fz_device_gray(ctx) : fz_device_rgb(ctx);
        pix = fz_new_pixmap_with_bbox(ctx, colorspace, pixelBox, nullptr, useAlpha ? 1 : 0);
        if (args.transparent && useAlpha) {
            fz_clear_pixmap(ctx, pix);
        } else {
            fz_clear_pixmap_with_value(ctx, pix, 0xff);
        }
        dev = fz_new_draw_device(ctx, deviceCtm, pix);
        fz_run_display_list(ctx, list, dev, kIdentity, pageSpan, nullptr);
        fz_close_device(ctx, dev);
        if (args.invert) {
            // Invert the rendered result. Clearing to black would only change the
            // *background*, leaving the (opaque white) page content white, which
            // is not an inverted page.
            fz_invert_pixmap(ctx, pix);
        }
    }
    fz_always(ctx) {
        if (dev) fz_drop_device(ctx, dev);
        fz_drop_display_list(ctx, list);
    }
    fz_catch(ctx) {
        failure = TakeCaughtMessage(ctx);
        failed = true;
        fz_drop_pixmap(ctx, pix);
        pix = nullptr;
    }

    if (failed || !pix) {
        if (!failure.empty()) PushDiagnostic(failure);
        return nullptr;
    }

    const int components = fz_pixmap_components(ctx, pix);
    const int stride = static_cast<int>(pix->stride);
    const size_t bytes = static_cast<size_t>(stride) * static_cast<size_t>(height);

    // Report the *actual* page-space rectangle the pixels cover, i.e. the
    // rounded device box mapped back through the page->device matrix. MuPDF snaps
    // the clip rectangle outwards to pixel boundaries, so this can be slightly
    // larger than the requested clip; the renderer needs the real one to place
    // the bitmap without drift.
    RectF actualRect = args.clip ? *args.clip : args.view->mediaBox;
    if (fz_matrix_expansion(pageToDevice) > 0) {
        const fz_rect deviceRect = fz_rect_from_irect(ibounds);
        const RectF inverse = ToRectF(fz_transform_rect(deviceRect, fz_invert_matrix(pageToDevice)));
        if (!inverse.IsEmpty()) {
            actualRect = inverse;
        }
    }

    out = new mupdf::Pixmap();
    out->width = width;
    out->height = height;
    out->stride = stride;
    out->components = components;
    out->x = ibounds.x0;
    out->y = ibounds.y0;
    out->pageRect = actualRect;
    out->samples.resize(bytes);
    if (bytes > 0 && pix->samples) {
        std::memcpy(out->samples.data(), pix->samples, bytes);
    }
    fz_drop_pixmap(ctx, pix);
    return out;
}

// ---------------------------------------------------------------------------
// Structured text
// ---------------------------------------------------------------------------

namespace {

// light-pdf: EngineMupdf.cpp NewTextPageOptions(). Accurate bboxes so selection
// rectangles hug the visible glyphs instead of the looser line-height boxes from
// the default mupdf extraction.
fz_stext_options NewTextPageOptions() {
    fz_stext_options opts{};
    opts.flags = FZ_STEXT_ACCURATE_BBOXES;
    return opts;
}

}  // namespace

// The single structured-text pass in the worker.
//
// It is run with an identity transform, NOT with the content -> page matrix, so
// every bbox and quad mupdf reports comes back in the same space as the rendered
// pixels. The reason is the one thing that is easy to get wrong here and is
// invisible until something is drawn: `fz_run_page` ALREADY applies the page's
// own transform (`pdf_run_page_contents_with_usage_imp` does
// `ctm = fz_concat(page_ctm, ctm)`), so passing `contentToPage` applies it a
// second time. For a page whose `/Rotate` is 0 the two are mutual inverses and
// cancel, which puts the text back in the page's raw user space — and a user-space
// box is 792-y where the raster is y, so every selection rectangle, search
// highlight and link on such a page is mirrored about the page's horizontal
// centre. On a page with a non-zero `/Rotate` it is worse, because the two
// transforms are then a rotation and its inverse.
//
// (fz_new_stext_page_from_page() also uses identity, but it leaves the box at the
// default MediaBox; this builds the page against the CropBox in fitz page space.)
fz_stext_page* PdfEngine::BuildStextPage(int pageIndex) {
    std::lock_guard<std::recursive_mutex> lock(renderMutex_);
    fz_context* ctx = Ctx();
    if (!ctx) {
        return nullptr;
    }

    fz_stext_page* stext = nullptr;
    fz_device* dev = nullptr;
    RectF pageBox{};
    fz_var(stext);
    fz_var(dev);

    {
        std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
        if (pageIndex < 0 || pageIndex >= pageCount_) {
            return nullptr;
        }
        const PageSlot& slot = pages_[static_cast<size_t>(pageIndex)];
        pageBox = slot.mediaBox;
    }

    const fz_stext_options opts = NewTextPageOptions();

    fz_try(ctx) {
        PageSlot* slot = GetPageLocked(ctx, pageIndex);
        if (!slot) {
            fz_throw(ctx, FZ_ERROR_FORMAT, "page %d is not available", pageIndex + 1);
        }
        stext = fz_new_stext_page(ctx, ToFzRect(pageBox));
        dev = fz_new_stext_device(ctx, stext, &opts);
        fz_run_page(ctx, slot->page, dev, kIdentity, nullptr);
        fz_close_device(ctx, dev);
    }
    fz_always(ctx) {
        if (dev) fz_drop_device(ctx, dev);
    }
    fz_catch(ctx) {
        fz_report_error(ctx);
        if (stext) fz_drop_stext_page(ctx, stext);
        return nullptr;
    }
    return stext;
}

// Block/line/span hierarchy for the `text` command, walked off the same
// structured-text page the flat glyph model is built from, so the two can never
// disagree about where a word is.
mupdf::PageTextInfo PdfEngine::ExtractPageText(int pageIndex) {
    mupdf::PageTextInfo info;
    fz_context* ctx = Ctx();
    if (!ctx) return info;

    fz_stext_page* stext = BuildStextPage(pageIndex);
    if (!stext) return info;

    RectF pageBox = MediaBox(pageIndex);
    info.width = pageBox.dx;
    info.height = pageBox.dy;

    fz_stext_block* block = stext->first_block;
    while (block) {
        if (block->type != FZ_STEXT_BLOCK_TEXT) {
            block = block->next;
            continue;
        }

        mupdf::TextBlock outBlock;
        outBlock.box = ToRectF(block->bbox).Intersect(pageBox);
        bool blockHasLines = false;

        fz_stext_line* line = block->u.t.first_line;
        while (line) {
            mupdf::TextLine outLine;
            outLine.box = ToRectF(line->bbox).Intersect(pageBox);
            mupdf::TextSpan currentSpan;
            bool spanOpen = false;

            fz_stext_char* c = line->first_char;
            while (c) {
                const std::string fontName = FontNameOf(ctx, c->font);
                // Coalesce consecutive chars sharing font and size into one
                // span, which is what the renderer draws text runs from.
                const bool sameStyle =
                    spanOpen && currentSpan.font == fontName && std::fabs(currentSpan.size - c->size) < 0.01f;
                if (!sameStyle) {
                    if (spanOpen) outLine.spans.push_back(std::move(currentSpan));
                    currentSpan = mupdf::TextSpan();
                    currentSpan.font = fontName;
                    currentSpan.size = c->size;
                    currentSpan.box = ToRectF(fz_rect_from_quad(c->quad)).Intersect(pageBox);
                    spanOpen = true;
                } else {
                    currentSpan.box = currentSpan.box.Union(ToRectF(fz_rect_from_quad(c->quad)).Intersect(pageBox));
                }
                if (c->c > 0 && c->c <= 0x10FFFF) {
                    char buf[8];
                    const int n = fz_runetochar(buf, c->c);
                    if (n > 0) currentSpan.text.append(buf, static_cast<size_t>(n));
                }
                c = c->next;
            }
            if (spanOpen) outLine.spans.push_back(std::move(currentSpan));
            if (!outLine.spans.empty()) {
                outBlock.lines.push_back(std::move(outLine));
                blockHasLines = true;
            }
            line = line->next;
        }

        if (blockHasLines) {
            info.blocks.push_back(std::move(outBlock));
        }
        block = block->next;
    }

    fz_drop_stext_page(ctx, stext);
    info.ok = true;
    return info;
}

// ---------------------------------------------------------------------------
// Links and outline
// ---------------------------------------------------------------------------

namespace {

// light-pdf: EngineMupdf.cpp ResolveLink(). Resolves a MuPDF link URI to a
// 1-based page number plus the destination point. Pulled out of the link loop so
// that the loop's own variables are not live across fz_try/fz_catch (mupdf
// throws with longjmp, and gcc is right to warn about that).
bool ResolveLinkUri(fz_context* ctx, fz_document* doc, const char* uri, int* pageNoOut, float* xOut, float* yOut,
                    float* zoomOut) {
    if (!uri || !doc) return false;
    bool resolved = false;
    fz_var(resolved);
    fz_link_dest dest{};
    int pageNo = -1;
    fz_var(dest);
    fz_var(pageNo);
    fz_try(ctx) {
        dest = fz_resolve_link_dest(ctx, doc, uri);
        pageNo = fz_page_number_from_location(ctx, doc, dest.loc);
    }
    fz_catch(ctx) {
        ReportCaughtError(ctx);
        pageNo = -1;
    }
    if (pageNo >= 0) {
        resolved = true;
        if (pageNoOut) *pageNoOut = pageNo + 1;
        if (xOut) *xOut = std::isnan(dest.x) ? 0.0f : dest.x;
        if (yOut) *yOut = std::isnan(dest.y) ? 0.0f : dest.y;
        // MuPDF reports zoom as a percentage; the worker exposes 1.0 = 100%.
        if (zoomOut) *zoomOut = std::isnan(dest.zoom) ? 0.0f : dest.zoom;
    }
    return resolved;
}

}  // namespace

std::vector<mupdf::LinkInfo> PdfEngine::Links(int pageIndex) {
    std::vector<mupdf::LinkInfo> out;
    fz_context* ctx = Ctx();
    if (!ctx) return out;

    std::lock_guard<std::recursive_mutex> lock(renderMutex_);

    fz_matrix contentToPage = kIdentity;
    {
        std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
        if (pageIndex < 0 || pageIndex >= pageCount_) return out;
        contentToPage = pages_[static_cast<size_t>(pageIndex)].contentToPage;
        if (fz_matrix_expansion(contentToPage) <= 0) {
            contentToPage = kIdentity;
        }
    }

    fz_link* links = nullptr;
    fz_var(links);
    fz_try(ctx) {
        PageSlot* slot = GetPageLocked(ctx, pageIndex);
        if (slot) {
            // fz_load_links() reports rectangles in the page's raw user space
            // (light-pdf uses them as-is because it clips in that same space).
            // The worker exposes fitz page space, so each rectangle is mapped
            // through contentToPage below.
            links = fz_load_links(ctx, slot->page);
        }
    }
    fz_catch(ctx) {
        fz_report_error(ctx);
        links = nullptr;
    }
    if (!links) return out;

    for (fz_link* link = links; link; link = link->next) {
        mupdf::LinkInfo info;
        // raw user space -> fitz page space
        info.box = ToRectF(fz_transform_rect(link->rect, contentToPage));
        if (link->uri) {
            info.uri = link->uri;
            // Internal targets ("#page=3", "#named") and named destinations
            // resolve; external URLs simply fail and stay a plain URI.
            float destX = 0;
            float destY = 0;
            float destZoom = 0;
            if (ResolveLinkUri(ctx, doc_, link->uri, &info.page, &destX, &destY, &destZoom)) {
                // Resolved destinations are in raw user space too.
                const fz_point pt = fz_transform_point(fz_make_point(destX, destY), contentToPage);
                info.x = pt.x;
                info.y = pt.y;
                info.zoom = destZoom;
            }
        }
        out.push_back(std::move(info));
    }

    fz_drop_link(ctx, links);
    return out;
}

namespace {

// light-pdf: EngineMupdf::BuildTocTree(). Walks fz_outline recursively, keeping
// nesting, the default open state and the resolved page number.
void BuildOutline(fz_context* ctx, fz_document* doc, fz_outline* node, std::vector<mupdf::OutlineNode>& out) {
    for (; node; node = node->next) {
        mupdf::OutlineNode item;
        if (node->title) {
            item.title = CleanPdfString(node->title);
        }
        if (node->uri) {
            item.uri = node->uri;
        }
        item.isOpen = node->is_open != 0;

        const int pageNo = fz_page_number_from_location(ctx, doc, node->page);
        if (pageNo >= 0) {
            item.page = pageNo + 1;
        } else if (node->uri) {
            ResolveLinkUri(ctx, doc, node->uri, &item.page, nullptr, nullptr, nullptr);
        }
        item.x = node->x;
        item.y = node->y;

        if (node->down) {
            BuildOutline(ctx, doc, node->down, item.children);
        }
        out.push_back(std::move(item));
    }
}

}  // namespace

std::vector<mupdf::OutlineNode> PdfEngine::Outline() {
    std::vector<mupdf::OutlineNode> out;
    fz_context* ctx = Ctx();
    if (!ctx) return out;
    std::lock_guard<std::recursive_mutex> stateLock(stateMutex_);
    if (!outline_) return out;
    fz_try(ctx) {
        BuildOutline(ctx, doc_, outline_, out);
    }
    fz_catch(ctx) {
        ReportCaughtError(ctx);
    }
    return out;
}

}  // namespace eukolia
