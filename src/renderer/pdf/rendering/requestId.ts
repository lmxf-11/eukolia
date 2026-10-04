// Shared by page and tile rendering, including remounted pipelines in this window.
let counter = 0;
export function nextPdfRequestId(): number { return ++counter; }
