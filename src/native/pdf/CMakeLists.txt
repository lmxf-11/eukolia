# Eukolia native PDF worker (eukolia-pdf.exe)
#
# This builds the long-lived child process that owns the MuPDF context and the
# tiled render cache. See PROTOCOL.md for the stdio binary protocol and
# ../../resources/native/README.md for the vendored runtime.
#
# The library lives in resources/native/libmupdf.dll. On MinGW the import
# library is generated with gendef/dlltool (see scripts/build-native-pdf.mjs,
# which is the primary path because CMake does not reliably find the Strawberry
# Perl MinGW toolchain). This CMakeLists is provided for IDEs and for machines
# with a normal MinGW or MSVC installation; it reuses the same generated
# import library when one is present.
#
# Usage:
#   cmake -S src/native/pdf -B build/native-pdf
#   cmake --build build/native-pdf --config Release
#
# Output: resources/native/eukolia-pdf.exe

cmake_minimum_required(VERSION 3.16)
project(eukolia-pdf CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# The worker is a plugin-style executable: it links the vendored MuPDF DLL by
# name (a fully resolved absolute path would break if the app directory moves).
set(CMAKE_BUILD_WITH_INSTALL_RPATH FALSE)

# Repository root: src/native/pdf -> ../../..
get_filename_component(EUKOLIA_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)

set(EUKOLIA_NATIVE_DIR "${EUKOLIA_ROOT}/resources/native")
set(EUKOLIA_MUPDF_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/third_party/mupdf/include")

if(NOT EXISTS "${EUKOLIA_MUPDF_INCLUDE}/mupdf/fitz.h")
  message(FATAL_ERROR
    "Vendored MuPDF headers missing at ${EUKOLIA_MUPDF_INCLUDE}.\n"
    "Run `node scripts/build-native-pdf.mjs --vendor` to restore them.")
endif()

if(NOT EXISTS "${EUKOLIA_NATIVE_DIR}/libmupdf.dll")
  message(FATAL_ERROR
    "Vendored runtime missing at ${EUKOLIA_NATIVE_DIR}/libmupdf.dll.\n"
    "Run `node scripts/build-native-pdf.mjs --vendor` to restore it.")
endif()

set(EUKOLIA_PDF_SOURCES
  src/protocol.cpp
  src/mupdf_engine.cpp
  src/render_cache.cpp
  src/worker_main.cpp
)

# The vendored light-pdf modules (see lightpdf/PORTING.md and
# scripts/build-native-pdf.mjs, which is the primary build path and carries the
# per-file rationale). These are the reference project's own sources: text
# selection, text search and page layout are compiled from here unchanged, and
# lightpdf/engine_mupdf_adapter.cpp is the EngineBase seam over the worker's
# mupdf layer.
set(EUKOLIA_LIGHTPDF_SOURCES
  lightpdf/CrashHandlerNoOp.cpp
  lightpdf/DisplayMode.cpp
  lightpdf/DocProperties.cpp
  lightpdf/DocumentLayout.cpp
  lightpdf/EngineBase.cpp
  lightpdf/TextSearch.cpp
  lightpdf/TextSelection.cpp
  lightpdf/TreeModel.cpp
  lightpdf/engine_mupdf_adapter.cpp
  lightpdf/base/Arena.cpp
  lightpdf/base/Arena_win.cpp
  lightpdf/base/Base.cpp
  lightpdf/base/Base_win.cpp
  lightpdf/base/Color.cpp
  lightpdf/base/File.cpp
  lightpdf/base/File_win.cpp
  lightpdf/base/Geom.cpp
  lightpdf/base/LogNoOp.cpp
  lightpdf/base/Str.cpp
  lightpdf/base/StrFormatParse.cpp
  lightpdf/base/StrUtf8.cpp
  lightpdf/base/StrQueue.cpp
  lightpdf/base/StrVec.cpp
  lightpdf/base/Strconv.cpp
  lightpdf/base/Thread.cpp
  lightpdf/base/WinDynCalls_win.cpp
)

add_executable(eukolia-pdf ${EUKOLIA_PDF_SOURCES} ${EUKOLIA_LIGHTPDF_SOURCES})

target_include_directories(eukolia-pdf PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_SOURCE_DIR}/lightpdf"
  "${EUKOLIA_MUPDF_INCLUDE}"
)

# Force-include the MinGW SDK-gap shim for the vendored translation units only
# (SetThreadDescription / the Windows 11 DWM constants); the worker's own sources
# do not need it and should not see it.
foreach(lightpdf_source IN LISTS EUKOLIA_LIGHTPDF_SOURCES)
  set_source_files_properties("${lightpdf_source}" PROPERTIES
    COMPILE_OPTIONS "-include;${CMAKE_CURRENT_SOURCE_DIR}/lightpdf/eukolia_win32_compat.h")
endforeach()

target_compile_definitions(eukolia-pdf PRIVATE
  NOMINMAX
  WIN32_LEAN_AND_MEAN
  _WIN32_WINNT=0x0601
  UNICODE
  _UNICODE
)

if(MSVC)
  target_compile_options(eukolia-pdf PRIVATE /W3 /permissive- /utf-8 /EHsc)
  # Build against the generated MSVC import library if one was produced.
  if(EXISTS "${EUKOLIA_NATIVE_DIR}/mupdf.lib")
    target_link_libraries(eukolia-pdf PRIVATE "${EUKOLIA_NATIVE_DIR}/mupdf.lib")
  elseif(EXISTS "${EUKOLIA_NATIVE_DIR}/libmupdf.lib")
    target_link_libraries(eukolia-pdf PRIVATE "${EUKOLIA_NATIVE_DIR}/libmupdf.lib")
  else()
    message(FATAL_ERROR
      "No MSVC import library found. Run `node scripts/build-native-pdf.mjs` "
      "or generate libmupdf.lib with `lib /def:` from libmupdf.def.")
  endif()
else()
  target_compile_options(eukolia-pdf PRIVATE -Wall -Wextra -Wno-unused-parameter -O2)
  # Warning classes the vendored light-pdf sources raise under GCC but not under
  # the MSVC build they are developed with; see scripts/build-native-pdf.mjs for
  # the per-class rationale.
  foreach(lightpdf_source IN LISTS EUKOLIA_LIGHTPDF_SOURCES)
    set_property(SOURCE "${lightpdf_source}" APPEND PROPERTY COMPILE_OPTIONS
      -Wno-cast-function-type -Wno-class-memaccess -Wno-sign-compare -Wno-type-limits
      -Wno-unused-variable -Wno-unused-but-set-variable -Wno-switch)
  endforeach()
  # Fully static libstdc++/libgcc so the exe has no extra MinGW DLL deps.
  target_link_options(eukolia-pdf PRIVATE -static-libgcc -static-libstdc++ -static)
  if(EXISTS "${EUKOLIA_NATIVE_DIR}/libmupdf.a")
    target_link_libraries(eukolia-pdf PRIVATE "${EUKOLIA_NATIVE_DIR}/libmupdf.a")
  else()
    message(FATAL_ERROR
      "MinGW import library ${EUKOLIA_NATIVE_DIR}/libmupdf.a not found.\n"
      "Run `node scripts/build-native-pdf.mjs` first: it generates the import "
      "library with gendef + dlltool.")
  endif()
endif()

# The exe is a runtime artefact of the app, not a build-tree artefact: put it
# next to the DLL it links so `resources/native/eukolia-pdf.exe` is complete.
set_target_properties(eukolia-pdf PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${EUKOLIA_NATIVE_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${EUKOLIA_NATIVE_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${EUKOLIA_NATIVE_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${EUKOLIA_NATIVE_DIR}"
  OUTPUT_NAME "eukolia-pdf"
)
