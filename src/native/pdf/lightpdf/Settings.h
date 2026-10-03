// Eukolia: compatibility header standing in for References/light-pdf/src/Settings.h.
//
// The real Settings.h is a 75 KB file generated from the whole application's
// settings schema (advanced options, themes, print settings, ...). The copied
// light-pdf modules use exactly four things out of it:
//
//   * the `DisplayMode` enum                         (DocumentLayoutParams::displayMode)
//   * the `kZoomFit*` family of zoom sentinels       (DocumentLayout.cpp)
//   * `FileState`                                    (DisplayMode.cpp's ZoomToString)
//   * nothing else.
//
// The declarations below are byte-for-byte the same as the generated original
// for those items (see References/light-pdf/src/Settings.h lines 8-28 and 367+);
// `FileState` is reduced to the three fields ZoomToString() reads. Everything
// else in the generated file is UI state that the headless worker has no use
// for and that would drag in the rest of the application.

#ifndef EUKOLIA_LIGHTPDF_SETTINGS_COMPAT_H
#define EUKOLIA_LIGHTPDF_SETTINGS_COMPAT_H

enum class DisplayMode {
    // automatic means: the continuous form of single page, facing or
    // book view - depending on the document's desired PageLayout
    Automatic = 0,
    SinglePage,
    Facing,
    BookView,
    Continuous,
    ContinuousFacing,
    ContinuousBookView,
};

constexpr float kZoomFitPage = -1.F;
constexpr float kZoomFitWidth = -2.F;
constexpr float kZoomFitContent = -3.F;
constexpr float kZoomShrinkToFit = -4.F;
constexpr float kZoomFitByOrientation = -5.F;
constexpr float kZoomActualSize = 100.0F;
constexpr float kZoomMax = 6400.F; /* max zoom in % */
constexpr float kZoomMin = 8.33F;  /* min zoom in % */
constexpr float kInvalidZoom = -99.0F;

// Reduced from the generated FileState: only the fields DisplayMode.cpp's
// ZoomToString() reads are kept.
struct FileState {
    // path of the document
    Str filePath;
    // how pages should be laid out for this document
    Str displayMode;
    // number of the last read page
    int pageNo;
};

#endif  // EUKOLIA_LIGHTPDF_SETTINGS_COMPAT_H
