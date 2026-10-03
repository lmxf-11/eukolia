// Eukolia: MinGW-w64 SDK gap shim for the vendored light-pdf sources.
//
// This header is force-included (`g++ -include`) ahead of every light-pdf
// translation unit. It exists only because MinGW-w64 13.2 (Strawberry Perl's
// toolchain) is missing one declaration that the Microsoft Windows SDK -- which
// light-pdf is authored against -- does provide, and that light-pdf's unmodified
// headers reference:
//
//   * `SetThreadDescription` (Windows 10 1607+). base/WinDynCalls.h:75 takes
//     `decltype(SetThreadDescription)`, so the name has to be declared for the
//     header to parse at all. It is never *called* from this worker: light-pdf's
//     Thread.cpp only uses it in the `OS_WIN && COMPILER_MSVC` branch, and the
//     dynamic loader resolves it with GetProcAddress.
//
// Deliberately does NOT include <windows.h>: Base.h controls the Win32 include
// order (winsock2.h before windows.h, NOMINMAX, ...) and force-including
// windows.h first would break it. The declaration below therefore uses the
// underlying types directly -- `long` is HRESULT, `void*` is HANDLE and
// `const wchar_t*` is PCWSTR -- which is exactly what the SDK declaration
// expands to. The calling convention is irrelevant here because nothing calls
// it; only the type identity matters for `decltype`.

#ifndef EUKOLIA_LIGHTPDF_WIN32_COMPAT_H
#define EUKOLIA_LIGHTPDF_WIN32_COMPAT_H

#if defined(_WIN32)

extern "C" long SetThreadDescription(void* hThread, const wchar_t* lpThreadDescription);

#endif  // _WIN32

#endif  // EUKOLIA_LIGHTPDF_WIN32_COMPAT_H
