// Eukolia: the slice of light-pdf's base/File.h layer that the compiled light-pdf
// modules still reference.
//
// light-pdf implements that layer twice: base/File.cpp (the portable helpers)
// plus either base/File_win.cpp or base/File_posix.cpp for the OS parts. Both OS
// implementations are out of reach in this worker:
//
//   * base/File_win.cpp sits on base/Win.cpp, which is light-pdf's entire Win32
//     shell layer -- registry, DDE, printing, clipboard, window management,
//     Gdiplus. It is ~130 KB of code a headless PDF worker must not carry, and it
//     does not compile outside light-pdf's own MSVC build configuration (it needs
//     the Windows SDK's ddeml.h/winspool.h and a UNICODE build).
//   * base/File_posix.cpp needs <sys/mman.h>, which MinGW-w64 does not ship.
//
// Only three of the layer's entry points are reachable from the light-pdf
// sources this worker links, and none of them is part of a PDF algorithm:
//
//   file::WriteFile()   -- EngineBase::SaveFileOrData()
//   file::Copy()        -- EngineBase::SaveFileOrData()
//   path::GetExtTemp()  -- DisplayMode::ZoomToString()
//
// The first two are thin wrappers over the same Win32 calls light-pdf's own
// base/File_win.cpp uses (CreateFileW(CREATE_ALWAYS) + WriteFile, and CopyFileW's
// fail-if-exists flag), so their behaviour is identical. GetExtTemp() is a copy
// of base/File.cpp's GetExtPos()/GetExtTemp().

#include "base/Base.h"
#include "base/File.h"

namespace file {

// light-pdf: base/File_win.cpp file::WriteFile().
bool WriteFile(Str path, Str d) {
    const void* data = (const void*)d.s;
    size_t dataLen = (size_t)d.len;
    HANDLE fh = CreateFileW(CWStrTemp(path), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
    if (INVALID_HANDLE_VALUE == fh) {
        return false;
    }
    DWORD written = 0;
    BOOL ok = ::WriteFile(fh, data, (DWORD)dataLen, &written, nullptr);
    CloseHandle(fh);
    ReportIf(ok && (dataLen != (size_t)written));
    return ok && dataLen == (size_t)written;
}

// light-pdf: base/File_win.cpp file::Copy().
bool Copy(Str dst, Str src, bool dontOverwrite) {
    return !!CopyFileW(CWStrTemp(src), CWStrTemp(dst), (BOOL)dontOverwrite);
}

} // namespace file

namespace path {

// light-pdf: base/File.cpp IsSep().
bool IsSep(char c) {
    return c == '\\' || c == '/';
}

// light-pdf: base/File.cpp GetExtPos().
static int GetExtPos(Str path) {
    int ext = -1;
    for (int i = 0; i < path.len; i++) {
        char c = path.s[i];
        if (c == '.') {
            ext = i;
        } else if (IsSep(c)) {
            ext = -1;
        }
    }
    return ext;
}

// light-pdf: base/File.cpp path::GetExtTemp().
TempStr GetExtTemp(Str path) {
    int ext = GetExtPos(path);
    if (ext < 0) {
        return StrL("");
    }
    return str::DupTemp(Str(path.s + ext, path.len - ext));
}

} // namespace path
