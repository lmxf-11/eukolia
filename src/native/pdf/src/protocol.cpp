// Protocol framing helpers.
//
// The framing constants and the MakeFrame() encoder live in protocol.h; this
// translation unit exists so that the frame-type table has a single definition
// and so that future additions (compression, chunked blobs) have a home.

#include "protocol.h"

namespace eukolia::proto {

// Intentionally empty: the framing is header-only by design so both the reader
// and the writer agree on the byte layout without a linkage dependency.

}  // namespace eukolia::proto
