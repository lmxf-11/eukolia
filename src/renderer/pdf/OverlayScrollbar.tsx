/**
 * Eukolia — light-pdf overlay scrollbar, ported.
 *
 * light-pdf's `OverlayScrollbar` is a semi-transparent top-level window that
 * floats over the document canvas: it never reserves layout width, it is thin
 * (4px, alpha 180) while idle, grows to 16px (alpha 220) with arrow buttons and
 * a track as soon as the pointer comes within 32px, and hides itself again a
 * few seconds after the pointer stops or after the last scroll.
 *
 * It is created **twice**, once per axis (`LightPDF.cpp:1226` for
 * `OverlayScrollbar::Type::Horz`, `:1281` for `Type::Vert`), and each is shown
 * only when its own axis overflows (`:1217` for the horizontal one, `:1263` for
 * the vertical one). This component reproduces that policy for the PDF pane,
 * with `orientation` selecting the axis: everything below is expressed in
 * "along the bar" terms, which is `y`/`height` for a vertical bar and
 * `x`/`width` for a horizontal one, exactly as `IsVert()` decides it in
 * `OverlayScrollbar.cpp:69`.
 *
 * The numbers all come from `LIGHTPDF_SCROLLBAR`, which transcribes
 * `OverlayScrollbar.cpp` / `.h`:
 *
 * - `GetThumbRect` thumb length `= trackLen * page / range`, floored at
 *   `kMinThumbSize` (20), offset via `MulDiv(pos, scrollableTrack, scrollableRange)`;
 * - `WM_LBUTTONDOWN` on the thumb starts a drag that tracks the pointer
 *   directly (`SB_THUMBTRACK`);
 * - a click on the track pages up/down depending on which side of the thumb
 *   middle it landed (`SB_PAGEUP` / `SB_PAGEDOWN`), and holding repeats after
 *   250ms at 400ms;
 * - the arrows in thick mode scroll one line (`SB_LINEUP` / `SB_LINEDOWN`) and
 *   repeat the same way;
 * - the global mouse tracker runs every 50ms, exactly like light-pdf's
 *   `MouseTrackTimerProc`.
 *
 * A drag or an arrow repeat writes the offset directly. It deliberately does
 * **not** use `scrollBy({ behavior: 'smooth' })` any more: that asks the browser
 * to animate the scroller, which is a second animation policy fighting the
 * viewer's own momentum integrator (`pdf.smoothScrollFriction`) and which also
 * makes every one of the integrator's per-frame writes animate instead of
 * applying. `Instructions.md` §35/§36's smooth scrolling is the viewer's, not
 * the compositor's.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  LIGHTPDF_SCROLLBAR,
  themeArrowColor,
  themeThumbColor,
  themeThumbHoverColor,
  themeTrackColor,
  withAlpha,
  type LightPdfThemeState
} from './lightpdf-theme';

/** `OverlayScrollbar.h` — `enum class State`. */
type SbState = 'Hidden' | 'SmartInvisible' | 'SmartThin' | 'SmartThick' | 'AlwaysThick';

/**
 * `OverlayScrollbar.h` — `enum class Type { Horz, Vert }`. The bar's geometry is
 * the only thing that differs between the two: which scroll offset it reads,
 * which extent it measures and which edge it hugs.
 */
export type OverlayScrollbarOrientation = 'vertical' | 'horizontal';

export interface OverlayScrollbarProps {
  /** The element that actually scrolls (the PDF pane scroller). */
  scroller: HTMLElement | null;
  /** light-pdf theme state, so the bar's colours are the app's own. */
  theme: LightPdfThemeState;
  /** Bumped by the viewer whenever the scrollable content changes size. */
  contentVersion: number;
  /** `OverlayScrollbar::Mode`; `Thick` shows the bar permanently. */
  mode?: 'Smart' | 'Thick';
  /**
   * `OverlayScrollbar::Type`. `vertical` (the default) is the bar light-pdf
   * hugs to the canvas's right edge; `horizontal` is the one it puts along the
   * bottom edge, which is what makes a page wider than the pane reachable.
   */
  orientation?: OverlayScrollbarOrientation;
}

interface Metrics {
  range: number;
  page: number;
  pos: number;
  trackLen: number;
  scrollableRange: number;
  /**
   * The thumb's position along the track, as last *drawn*. Compared (rounded, to a
   * whole pixel) instead of `pos`, so a glide re-renders the bar only when the
   * reader can see the thumb move.
   */
  thumbOffset: number;
}

/** `OverlayScrollbar.cpp` — `IsThick`. */
function isThick(state: SbState): boolean {
  return state === 'SmartThick' || state === 'AlwaysThick';
}

/** `OverlayScrollbar.cpp` — `IsVisible`. */
function isVisible(state: SbState): boolean {
  return state === 'SmartThin' || state === 'SmartThick' || state === 'AlwaysThick';
}

export const OverlayScrollbar: React.FC<OverlayScrollbarProps> = ({
  scroller,
  theme,
  contentVersion,
  mode = 'Smart',
  orientation = 'vertical'
}) => {
  /** `OverlayScrollbar.cpp:69` — `IsVert`. */
  const isVert = orientation === 'vertical';
  const [state, setState] = useState<SbState>('Hidden');
  const [metrics, setMetrics] = useState<Metrics>({ range: 0, page: 0, pos: 0, trackLen: 0, scrollableRange: 0, thumbOffset: 0 });
  const [hoverThumb, setHoverThumb] = useState(false);
  const [trackHeight, setTrackHeight] = useState(0);

  const stateRef = useRef<SbState>('Hidden');
  const draggingRef = useRef(false);
  const dragStartPointerRef = useRef(0);
  const dragStartPosRef = useRef(0);
  const trackPosRef = useRef(0);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerRef = useRef({ x: -1, y: -1, at: 0 });
  const hostRef = useRef<HTMLDivElement | null>(null);

  const thick = isThick(state);
  const visible = isVisible(state);
  const width = thick ? LIGHTPDF_SCROLLBAR.thickWidth : LIGHTPDF_SCROLLBAR.thinWidth;
  const alpha = thick ? LIGHTPDF_SCROLLBAR.alphaThick : LIGHTPDF_SCROLLBAR.alphaThin;
  // `OverlayScrollbar.cpp` — in thick mode the track and both arrows are carved
  // out of the ends with a 2px gap, so the thumb travels between them.
  const arrowSize = thick ? width : 0;
  const trackInset = thick ? arrowSize + 2 : 0;

  // --------------------------------------------------------------- geometry

  /** The scroll offset this bar drives — `GetScrollPos(SB_VERT | SB_HORZ)`. */
  const readPos = useCallback(
    (element: HTMLElement): number => (isVert ? element.scrollTop : element.scrollLeft),
    [isVert]
  );

  /**
   * The scroll range and the track's length — read when the *layout* changes, not
   * when the offset does.
   *
   * `scrollHeight` and `clientHeight` are layout reads: asking for them inside a
   * scroll event, which fires once per frame while the reader scrolls, is the
   * classic way to force a style and layout flush on the frame the compositor is
   * trying to keep up with. light-pdf's own bar does a `SetScrollInfo` /
   * `GetScrollInfo` round trip per tick (`Canvas.cpp:737-738`), but that is a
   * cheap kernel call, not a layout pass — the browser equivalent of "the range
   * did not change" is to keep the last answer.
   */
  const extentRef = useRef({ range: 0, page: 0, trackLen: 0, scrollableRange: 0 });
  const readExtent = useCallback(() => {
    if (!scroller) return;
    // `IsVert(sb) ? track.dy : track.dx` throughout `GetThumbRect`.
    const range = isVert ? scroller.scrollHeight : scroller.scrollWidth;
    const page = isVert ? scroller.clientHeight : scroller.clientWidth;
    const trackLen = Math.max(0, page - trackInset * 2);
    const scrollableRange = Math.max(0, range - page);
    extentRef.current = { range, page, trackLen, scrollableRange };
    // The bar's own length is the owner's extent across its axis: `height: 100%`
    // for vertical, `width: 100%` for horizontal.
    setTrackHeight((previous) => (previous === page ? previous : page));
  }, [scroller, trackInset, isVert]);

  const readMetrics = useCallback(() => {
    if (!scroller) return;
    readExtent();
    const pos = isVert ? scroller.scrollTop : scroller.scrollLeft;
    const { range, page, trackLen, scrollableRange } = extentRef.current;
    // Only re-render when something actually changed: this runs on every layout
    // change, and §62 asks scrolling to stay free of avoidable work.
    setMetrics((previous) =>
      previous.range === range &&
      previous.page === page &&
      previous.pos === pos &&
      previous.trackLen === trackLen &&
      previous.scrollableRange === scrollableRange
        ? previous
        : { range, page, pos, trackLen, scrollableRange, thumbOffset: Number.NaN }
    );
  }, [scroller, readExtent, isVert]);

  /**
   * One frame of scroll-derived bookkeeping, for any number of scroll events.
   *
   * The offset is read once, the thumb is placed, and React is only told when the
   * *drawn* thumb moved — quantised to a whole pixel, which is all a four-pixel
   * bar can show. The state of the bar (`showBar`) rides the same frame instead of
   * its own listener.
   */
  const metricsFrameRef = useRef(0);
  const lastPosRef = useRef(Number.NaN);
  /**
   * The scroller and `showBar` are declared outside this callback — `showBar`
   * depends on the bar's own state machine and comes later in the file — so both
   * are read through refs, which also keeps the scroll listener subscribed once
   * (re-subscribing it whenever a callback identity changed would drop scroll
   * events in the gap).
   */
  const scrollerRef = useRef(scroller);
  scrollerRef.current = scroller;
  const showBarRef = useRef<(thick: boolean) => void>(() => undefined);
  const scheduleMetrics = useCallback(() => {
    if (metricsFrameRef.current) return;
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = 0;
      const owner = scrollerRef.current;
      if (!owner) return;
      const pos = isVert ? owner.scrollTop : owner.scrollLeft;
      const { range, page, trackLen, scrollableRange } = extentRef.current;
      if (pos !== lastPosRef.current) {
        lastPosRef.current = pos;
        if (!draggingRef.current) showBarRef.current(false);
      }
      const length = page >= range ? trackLen : Math.max(LIGHTPDF_SCROLLBAR.minThumbSize, (trackLen * page) / range);
      const scrollableTrack = Math.max(0, trackLen - length);
      const offset =
        scrollableRange > 0 && range > 0 && page < range
          ? Math.min(Math.max((pos * scrollableTrack) / scrollableRange, 0), scrollableTrack)
          : 0;
      /**
       * React is told only when the *drawn* thumb moved a whole pixel. The offset
       * itself changes on every frame of a glide, but a four-pixel bar cannot show
       * that, and each state update is a commit on the frame the scroll is using.
       */
      setMetrics((previous) =>
        previous.range === range &&
        previous.page === page &&
        previous.trackLen === trackLen &&
        previous.scrollableRange === scrollableRange &&
        Math.round(previous.thumbOffset) === Math.round(offset)
          ? previous
          : { range, page, pos, trackLen, scrollableRange, thumbOffset: offset }
      );
    });
  }, [isVert]);

  useEffect(() => {
    readMetrics();
  }, [readMetrics, contentVersion]);

  useEffect(() => {
    if (!scroller) return;
    // The range and the track length are layout facts: they change when the layout
    // or the pane does, which the observer below is what reports.
    readExtent();
    const onScroll = () => scheduleMetrics();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => readMetrics());
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (metricsFrameRef.current) cancelAnimationFrame(metricsFrameRef.current);
      metricsFrameRef.current = 0;
      observer?.disconnect();
    };
  }, [scroller, readExtent, readMetrics, scheduleMetrics]);

  // `OverlayScrollbar.cpp` — `GetThumbRect`.
  const thumb = useMemo(() => {
    const { range, page, pos, trackLen, scrollableRange, thumbOffset } = metrics;
    if (range <= 0 || trackLen <= 0) return { offset: 0, length: 0 };
    if (page >= range) return { offset: 0, length: trackLen };
    const raw = (trackLen * page) / range;
    const length = Math.max(LIGHTPDF_SCROLLBAR.minThumbSize, raw);
    const scrollableTrack = trackLen - length;
    // The scroll path records the offset it already worked out, rounded to the
    // pixel the reader can see; the arithmetic below stays for the drag, which
    // follows the pointer rather than the scroll offset.
    if (!draggingRef.current && Number.isFinite(thumbOffset)) {
      return { offset: Math.min(Math.max(thumbOffset, 0), Math.max(0, scrollableTrack)), length };
    }
    const usedPos = draggingRef.current ? trackPosRef.current : pos;
    let offset = 0;
    if (scrollableRange > 0) {
      offset = ((usedPos - 0) * scrollableTrack) / scrollableRange;
    }
    return { offset: Math.min(Math.max(offset, 0), scrollableTrack), length };
  }, [metrics]);

  /**
   * The thumb geometry, for the tracker below to read *without* depending on it.
   *
   * The tracker is a 50 ms interval whose body compares the pointer against where
   * the thumb is drawn. Listing `thumb.offset` and `thumb.length` as dependencies
   * read as harmless and was not: the thumb moves whenever the scroll offset moves,
   * which is every frame of a gesture, so each of those commits tore the interval
   * down and built a new one — and a new interval starts its 50 ms phase again, so
   * during a scroll (or a thumb drag, where the metrics are re-read per
   * `pointermove`) the callback could never fire at all. The proximity thickening,
   * the hover colour and the hide-once-the-pointer-stops rule were all suspended
   * exactly while the reader was scrolling.
   *
   * A ref gives the callback the current value at call time and leaves the interval
   * alone, which is what the tracker wanted in the first place.
   */
  const thumbRef = useRef(thumb);
  thumbRef.current = thumb;

  // ------------------------------------------------------------ state change

  const setSbState = useCallback(
    (next: SbState) => {
      if (stateRef.current === next) return;
      stateRef.current = next;
      setState(next);
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
      // `OverlayScrollbar.cpp` — `SetState`: a thin bar arms `showAfterScrollMs`.
      if (next === 'SmartThin') {
        autoHideTimerRef.current = setTimeout(() => {
          autoHideTimerRef.current = null;
          if (!draggingRef.current) {
            stateRef.current = 'SmartInvisible';
            setState('SmartInvisible');
          }
        }, LIGHTPDF_SCROLLBAR.showAfterScrollMs);
      }
    },
    []
  );

  // `OverlayScrollbar.cpp` — `ShowScrollbarWindow` / `HideScrollbarWindow`.
  const showBar = useCallback(
    (wantThick: boolean) => {
      if (draggingRef.current && !wantThick) return;
      if (mode === 'Thick') {
        setSbState('AlwaysThick');
        return;
      }
      setSbState(wantThick ? 'SmartThick' : 'SmartThin');
    },
    [mode, setSbState]
  );

  showBarRef.current = showBar;

  const hideBar = useCallback(() => {
    if (draggingRef.current) return;
    if (mode === 'Thick') return;
    setSbState('SmartInvisible');
  }, [mode, setSbState]);

  // Any scroll re-shows the bar as thin, exactly like `OverlayScrollbarSetInfo` —
  // and it rides the same per-frame pass as the thumb (`scheduleMetrics`), rather
  // than being a second listener reading the offset again on every scroll event.

  // Show the bar once there is something to scroll.
  useEffect(() => {
    if (metrics.scrollableRange > 0 && stateRef.current === 'Hidden') {
      showBar(false);
    }
  }, [metrics.scrollableRange, showBar]);

  // ------------------------------------------- global mouse tracking (50ms)

  useEffect(() => {
    if (mode === 'Thick') {
      setSbState('AlwaysThick');
      return;
    }
    const interval = setInterval(() => {
      const host = hostRef.current;
      const owner = scroller;
      if (!host || !owner) return;

      const pointer = lastPointerRef.current;
      const now = Date.now();
      const ownerRect = owner.getBoundingClientRect();
      const overOwner =
        pointer.x >= ownerRect.left && pointer.x <= ownerRect.right && pointer.y >= ownerRect.top && pointer.y <= ownerRect.bottom;

      // `GetScrollbarScreenRect` uses the *thick* width for the proximity test,
      // and it tests against the edge this bar hugs: the right edge for the
      // vertical bar, the bottom edge for the horizontal one.
      const barStart = isVert ? ownerRect.right - LIGHTPDF_SCROLLBAR.thickWidth : ownerRect.bottom - LIGHTPDF_SCROLLBAR.thickWidth;
      const along = isVert ? pointer.x : pointer.y;
      const edge = isVert ? ownerRect.right : ownerRect.bottom;
      const across = along < barStart ? barStart - along : along > edge ? along - edge : 0;
      const dx = isVert ? across : pointer.x < ownerRect.left ? ownerRect.left - pointer.x : pointer.x > ownerRect.right ? pointer.x - ownerRect.right : 0;
      const dy = isVert ? (pointer.y < ownerRect.top ? ownerRect.top - pointer.y : pointer.y > ownerRect.bottom ? pointer.y - ownerRect.bottom : 0) : across;
      const distance = Math.max(dx, dy);
      const closeToBar = distance <= LIGHTPDF_SCROLLBAR.thickVisibilityDistance;

      if (draggingRef.current) return;

      if (closeToBar && overOwner) {
        showBar(true);
        const current = thumbRef.current;
        const thumbStart = trackInset + current.offset;
        const pointerAlong = isVert ? pointer.y : pointer.x;
        const ownerStart = isVert ? ownerRect.top : ownerRect.left;
        const overThumb =
          pointerAlong >= ownerStart + thumbStart && pointerAlong <= ownerStart + thumbStart + current.length;
        setHoverThumb((previous) => (previous === overThumb ? previous : overThumb));
        return;
      }

      // Not near the bar: fall back to thin, then hide once the pointer stops.
      const stopped = now - pointer.at >= LIGHTPDF_SCROLLBAR.hideAfterMouseStopMs;
      if (isThick(stateRef.current)) {
        showBar(false);
        return;
      }
      if (stopped && stateRef.current === 'SmartThin') {
        hideBar();
      }
    }, LIGHTPDF_SCROLLBAR.mouseTrackIntervalMs);
    return () => clearInterval(interval);
    // `thumbRef` above is what keeps the geometry out of this list: the tracker
    // reads it at call time, so the interval is built once rather than once per
    // pixel the thumb moves.
  }, [mode, scroller, showBar, hideBar, setSbState, trackInset, isVert]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // --------------------------------------------------------------- scrolling

  const pageBy = useCallback(
    (fraction: number) => {
      if (!scroller) return;
      // light-pdf's SB_PAGEUP/SB_PAGEDOWN scroll by one pageful of the axis the
      // bar belongs to. The offset is written directly rather than through
      // `scrollBy({ behavior: 'smooth' })`: the browser's animation would fight
      // the viewer's momentum integrator, which is the repo's own smooth-scroll
      // policy (§35/§36).
      const page = isVert ? scroller.clientHeight : scroller.clientWidth;
      if (isVert) scroller.scrollTop += page * fraction;
      else scroller.scrollLeft += page * fraction;
    },
    [scroller, isVert]
  );

  const lineBy = useCallback(
    (delta: number) => {
      if (!scroller) return;
      if (isVert) scroller.scrollTop += delta;
      else scroller.scrollLeft += delta;
    },
    [scroller, isVert]
  );

  const scrollToOffset = useCallback(
    (offset: number) => {
      if (!scroller) return;
      const clamped = Math.max(0, Math.min(metrics.scrollableRange, offset));
      if (isVert) scroller.scrollTop = clamped;
      else scroller.scrollLeft = clamped;
    },
    [scroller, metrics.scrollableRange, isVert]
  );

  // Arrow / track press-and-hold repeat (`kTimerRepeatScroll`).
  const repeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRepeat = useCallback(() => {
    if (repeatRef.current) {
      clearTimeout(repeatRef.current);
      repeatRef.current = null;
    }
  }, []);

  const startRepeat = useCallback(
    (action: () => void) => {
      stopRepeat();
      action();
      const tick = () => {
        repeatRef.current = setTimeout(() => {
          action();
          tick();
        }, LIGHTPDF_SCROLLBAR.repeatRateMs);
      };
      repeatRef.current = setTimeout(() => {
        action();
        tick();
      }, LIGHTPDF_SCROLLBAR.repeatInitialDelayMs);
    },
    [stopRepeat]
  );

  useEffect(() => stopRepeat, [stopRepeat]);

  // ------------------------------------------------------------------ events

  const onThumbPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scroller) return;
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = true;
      dragStartPointerRef.current = isVert ? event.clientY : event.clientX;
      dragStartPosRef.current = readPos(scroller);
      trackPosRef.current = dragStartPosRef.current;
      // SB_THUMBTRACK is immediate in light-pdf, so the drag disables the CSS
      // smooth behaviour for its duration and writes the offset itself.
      const previousBehaviour = scroller.style.scrollBehavior;
      scroller.style.scrollBehavior = 'auto';
      (event.target as HTMLElement).setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const { trackLen } = metrics;
        const length = thumb.length;
        const scrollableTrack = Math.max(0, trackLen - length);
        const { scrollableRange } = metrics;
        const delta = (isVert ? moveEvent.clientY : moveEvent.clientX) - dragStartPointerRef.current;
        let position = dragStartPosRef.current;
        if (scrollableTrack > 0 && scrollableRange > 0) {
          position = dragStartPosRef.current + (delta * scrollableRange) / scrollableTrack;
        }
        position = Math.max(0, Math.min(scrollableRange, position));
        trackPosRef.current = position;
        if (isVert) scroller.scrollTop = position;
        else scroller.scrollLeft = position;
        setMetrics((previous) => ({ ...previous, pos: position, thumbOffset: Number.NaN }));
      };

      const onUp = () => {
        draggingRef.current = false;
        scroller.style.scrollBehavior = previousBehaviour;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        showBar(false);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [scroller, metrics, thumb.length, showBar, isVert, readPos]
  );

  const onTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scroller) return;
      const hostRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const ownerStart = isVert ? hostRect.top : hostRect.left;
      const pointerAlong = isVert ? event.clientY : event.clientX;
      const thumbStart = ownerStart + trackInset + thumb.offset;
      const thumbMiddle = thumbStart + thumb.length / 2;
      if (pointerAlong < thumbStart) startRepeat(() => pageBy(-1));
      else if (pointerAlong > thumbStart + thumb.length) startRepeat(() => pageBy(1));
      else if (pointerAlong < thumbMiddle) startRepeat(() => pageBy(-1));
      else startRepeat(() => pageBy(1));
    },
    [scroller, trackInset, thumb.offset, thumb.length, startRepeat, pageBy, isVert]
  );

  useEffect(() => {
    const onUp = () => stopRepeat();
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [stopRepeat]);

  // ---------------------------------------------------------------- painting

  if (!scroller || metrics.scrollableRange <= 0 || trackHeight <= 0) {
    return null;
  }

  const thumbColor = hoverThumb ? themeThumbHoverColor(theme) : themeThumbColor(theme);
  const arrowColor = themeArrowColor(theme);

  /**
   * The bar's own box. A vertical bar hugs the right edge at the owner's full
   * height; a horizontal one hugs the bottom edge at the owner's full width —
   * `IsVert(sb)` in `OverlayScrollbar.cpp` picks between the two everywhere the
   * reference measures its track.
   */
  const hostBox: React.CSSProperties = isVert
    ? { position: 'absolute', top: 0, right: 0, width, height: '100%' }
    : { position: 'absolute', left: 0, bottom: 0, height: width, width: '100%' };
  /** The thumb's cross-axis inset: centred for a thin bar, flush for a thick one. */
  const thumbCross = thick ? 0 : (width - LIGHTPDF_SCROLLBAR.thinWidth) / 2;
  const thumbBox: React.CSSProperties = isVert
    ? {
        position: 'absolute',
        left: thick ? 0 : thumbCross,
        top: trackInset + thumb.offset,
        width: thick ? width : LIGHTPDF_SCROLLBAR.thinWidth,
        height: thumb.length
      }
    : {
        position: 'absolute',
        top: thick ? 0 : thumbCross,
        left: trackInset + thumb.offset,
        height: thick ? width : LIGHTPDF_SCROLLBAR.thinWidth,
        width: thumb.length
      };

  return (
    <div
      ref={hostRef}
      data-testid="pdf-overlay-scrollbar"
      data-orientation={orientation}
      data-scrollbar-state={state}
      style={{
        ...hostBox,
        zIndex: 6,
        // The bar floats above the canvas and never reserves layout space.
        pointerEvents: visible ? 'auto' : 'none',
        background: thick ? withAlpha(hexOf(themeTrackColor(theme)), alpha) : 'transparent',
        transition: isVert ? 'width 80ms linear' : 'height 80ms linear',
        cursor: 'default'
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onTrackPointerDown(event);
      }}
    >
      {thick && LIGHTPDF_SCROLLBAR.thickArrows && (
        <>
          <ArrowButton
            direction="start"
            orientation={orientation}
            size={arrowSize}
            colorHex={hexOf(arrowColor)}
            alpha={alpha}
            onClick={() => startRepeat(() => lineBy(-40))}
          />
          <ArrowButton
            direction="end"
            orientation={orientation}
            size={arrowSize}
            colorHex={hexOf(arrowColor)}
            alpha={alpha}
            onClick={() => startRepeat(() => lineBy(40))}
          />
        </>
      )}

      <div data-testid="pdf-overlay-scrollbar-thumb" onPointerDown={onThumbPointerDown} style={{ ...thumbBox, background: withAlpha(hexOf(thumbColor), alpha), cursor: 'default' }} />
    </div>
  );
};

/**
 * `OverlayScrollbar.cpp` with `gThickArrows = true`: small filled triangles
 * drawn with `sz = arrowSize / 3` around the arrow box's centre, using the
 * points `(cx, cy - 0.7sz)`, `(cx - sz, cy + 0.7sz)`, `(cx + sz, cy + 0.7sz)`.
 *
 * `start` is `SB_LINEUP` / `SB_LINELEFT` — the arrow at the top of a vertical bar
 * and at the left of a horizontal one; `end` is the other one.
 */
const ArrowButton: React.FC<{
  direction: 'start' | 'end';
  orientation: OverlayScrollbarOrientation;
  size: number;
  colorHex: string;
  alpha: number;
  onClick(): void;
}> = ({ direction, orientation, size, colorHex, alpha, onClick }) => {
  const sz = size / 3;
  const centre = size / 2;
  const atEnd = direction === 'end';
  // The triangle always points along the bar, towards the end it scrolls to.
  const points = orientation === 'vertical'
    ? atEnd
      ? `${centre - sz},${centre - sz * 0.7} ${centre + sz},${centre - sz * 0.7} ${centre},${centre + sz * 0.7}`
      : `${centre},${centre - sz * 0.7} ${centre - sz},${centre + sz * 0.7} ${centre + sz},${centre + sz * 0.7}`
    : atEnd
      ? `${centre - sz * 0.7},${centre - sz} ${centre - sz * 0.7},${centre + sz} ${centre + sz * 0.7},${centre}`
      : `${centre - sz * 0.7},${centre} ${centre + sz * 0.7},${centre - sz} ${centre + sz * 0.7},${centre + sz}`;
  const box: React.CSSProperties =
    orientation === 'vertical'
      ? { position: 'absolute', top: atEnd ? `calc(100% - ${size}px)` : 0, left: 0, width: size, height: size }
      : { position: 'absolute', left: atEnd ? `calc(100% - ${size}px)` : 0, top: 0, width: size, height: size };
  return (
    <div onClick={onClick} style={box}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <polygon points={points} fill={colorHex} fillOpacity={alpha / 255} />
      </svg>
    </div>
  );
};

/** `COLORREF` → `#rrggbb`; kept local so the component has no colour maths of its own. */
function hexOf(color: number): string {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
