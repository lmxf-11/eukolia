/**
 * SplitPane — the drag-resizable two-pane splitter used for the editor/PDF,
 * visual/PDF and any other side-by-side layout (Instructions.md §42).
 *
 * The divider is a real control: it is focusable, responds to arrow keys
 * Home/End, resets to 50% on double-click, and keeps the pointer captured during
 * a drag so a fast drag can never "lose" the pointer and leave the layout stuck.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface SplitPaneProps {
  /** `horizontal` puts the panes side by side; `vertical` stacks them. */
  direction: 'horizontal' | 'vertical';
  /** Initial size of the first pane, as a percentage. */
  initial: number;
  min?: number;
  max?: number;
  children: [React.ReactNode, React.ReactNode];
  onResize?(ratio: number): void;
  /** `localStorage` key the ratio is remembered under. */
  storageKey?: string;
}

export const DEFAULT_MIN_RATIO = 0;
export const DEFAULT_MAX_RATIO = 100;
export const KEYBOARD_STEP_RATIO = 2;
export const KEYBOARD_PAGE_STEP_RATIO = 10;
export const RESET_RATIO = 50;

/**
 * The seam is exactly one pixel of layout: a single rule that both panes sit
 * against, so nothing is doubled and no gap opens beside the line.
 */
export const DIVIDER_RULE_PIXELS = 1;

/**
 * The grab box around that rule. It is wider than the line and completely
 * transparent, so a comfortable target costs no visible thickness.
 */
export const DIVIDER_HIT_AREA_PIXELS = 5;

/** The divider's measurements, in pixels. */
export interface DividerGeometry {
  /** Thickness of the visible rule, across the split. */
  rulePixels: number;
  /** Width of the transparent grab box centred on the rule. */
  hitAreaPixels: number;
  /** How far the grab box overhangs into each of the two panes. */
  overhangPixels: number;
  /** The pointer shown over the grab box. */
  cursor: 'col-resize' | 'row-resize';
}

/**
 * The divider's geometry for one axis, kept pure so the "1px line, 5px target"
 * invariant can be tested without a DOM.
 */
export function dividerGeometry(direction: 'horizontal' | 'vertical'): DividerGeometry {
  return {
    rulePixels: DIVIDER_RULE_PIXELS,
    hitAreaPixels: DIVIDER_HIT_AREA_PIXELS,
    // Symmetric, so the rule stays centred inside the grab box.
    overhangPixels: (DIVIDER_HIT_AREA_PIXELS - DIVIDER_RULE_PIXELS) / 2,
    cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize'
  };
}

/** Clamps a pane ratio into `[min, max]`, both expressed as percentages. */
export function clampRatio(value: number, min: number = DEFAULT_MIN_RATIO, max: number = DEFAULT_MAX_RATIO): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Converts a pointer movement in pixels into a clamped pane ratio. */
export function ratioFromPointerDelta(
  startRatio: number,
  deltaPixels: number,
  containerPixels: number,
  min: number = DEFAULT_MIN_RATIO,
  max: number = DEFAULT_MAX_RATIO
): number {
  if (!Number.isFinite(containerPixels) || containerPixels <= 0) return clampRatio(startRatio, min, max);
  return clampRatio(startRatio + (deltaPixels / containerPixels) * 100, min, max);
}

/** Reads a remembered ratio, falling back to `initial` when nothing usable is stored. */
export function readStoredRatio(
  storageKey: string | undefined,
  initial: number,
  min: number = DEFAULT_MIN_RATIO,
  max: number = DEFAULT_MAX_RATIO
): number {
  if (!storageKey) return clampRatio(initial, min, max);
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return clampRatio(initial, min, max);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return clampRatio(initial, min, max);
    return clampRatio(parsed, min, max);
  } catch {
    // Storage can be unavailable; the pane still works for this session.
    return clampRatio(initial, min, max);
  }
}

function storeRatio(storageKey: string | undefined, ratio: number): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, String(Math.round(ratio * 1000) / 1000));
  } catch {
    /* ignore: persistence is best effort */
  }
}

export const SplitPane: React.FC<SplitPaneProps> = ({ direction, initial, min = DEFAULT_MIN_RATIO, max = DEFAULT_MAX_RATIO, children, onResize, storageKey }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState(() => readStoredRatio(storageKey, initial, min, max));
  const [dragging, setDragging] = useState(false);

  // Reset when the splitter is pointed at a different layout.
  useEffect(() => {
    setRatio(readStoredRatio(storageKey, initial, min, max));
  }, [storageKey, initial, min, max]);

  const applyRatio = useCallback(
    (next: number) => setRatio(clampRatio(next, min, max)),
    [min, max]
  );

  useEffect(() => {
    const timer = setTimeout(() => storeRatio(storageKey, ratio), 150);
    return () => clearTimeout(timer);
  }, [ratio, storageKey]);

  useEffect(() => {
    onResize?.(ratio);
  }, [onResize, ratio]);

  // ------------------------------------------------------------------ drag

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const divider = event.currentTarget;
      const container = containerRef.current;
      if (!container) return;

      const horizontal = direction === 'horizontal';
      const containerPixels = horizontal ? container.clientWidth : container.clientHeight;
      const startPosition = horizontal ? event.clientX : event.clientY;
      const startRatio = ratio;

      divider.setPointerCapture(event.pointerId);
      setDragging(true);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const current = horizontal ? moveEvent.clientX : moveEvent.clientY;
        applyRatio(ratioFromPointerDelta(startRatio, current - startPosition, containerPixels, min, max));
      };

      const onPointerUp = () => {
        divider.removeEventListener('pointermove', onPointerMove);
        divider.removeEventListener('pointerup', onPointerUp);
        divider.removeEventListener('pointercancel', onPointerUp);
        try {
          divider.releasePointerCapture(event.pointerId);
        } catch {
          /* the pointer may already have been released */
        }
        setDragging(false);
      };

      divider.addEventListener('pointermove', onPointerMove);
      divider.addEventListener('pointerup', onPointerUp);
      divider.addEventListener('pointercancel', onPointerUp);
    },
    [applyRatio, direction, max, min, ratio]
  );

  // -------------------------------------------------------------- keyboard

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const horizontal = direction === 'horizontal';
      const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
      const step = event.shiftKey ? KEYBOARD_PAGE_STEP_RATIO : KEYBOARD_STEP_RATIO;

      switch (event.key) {
        case back:
          event.preventDefault();
          applyRatio(ratio - step);
          break;
        case forward:
          event.preventDefault();
          applyRatio(ratio + step);
          break;
        case 'PageUp':
          event.preventDefault();
          applyRatio(ratio - KEYBOARD_PAGE_STEP_RATIO);
          break;
        case 'PageDown':
          event.preventDefault();
          applyRatio(ratio + KEYBOARD_PAGE_STEP_RATIO);
          break;
        case 'Home':
          event.preventDefault();
          applyRatio(min);
          break;
        case 'End':
          event.preventDefault();
          applyRatio(max);
          break;
        default:
          break;
      }
    },
    [applyRatio, direction, max, min, ratio]
  );

  const horizontal = direction === 'horizontal';

  const geometry = dividerGeometry(direction);

  /*
   * The rule *is* the flex item: one pixel of layout between the two panes.
   * `alignSelf: 'stretch'` is what makes it run the whole way — from the first
   * pane's top edge to the last one's bottom edge — without relying on a
   * percentage height resolving against a flexed parent.
   */
  const dividerStyle: React.CSSProperties = horizontal
    ? { position: 'relative', width: geometry.rulePixels, alignSelf: 'stretch', cursor: geometry.cursor, flexShrink: 0, touchAction: 'none' }
    : { position: 'relative', height: geometry.rulePixels, alignSelf: 'stretch', cursor: geometry.cursor, flexShrink: 0, touchAction: 'none' };

  /*
   * A transparent grab box centred on the rule — wider than the line, and
   * painted above the panes, so the divider can be grabbed comfortably without
   * the seam ever growing past one pixel. It overhangs both panes equally,
   * which is also what keeps the corner with the PDF toolbar square.
   */
  const hitAreaStyle: React.CSSProperties = horizontal
    ? {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: -geometry.overhangPixels,
        width: geometry.hitAreaPixels,
        background: 'transparent',
        zIndex: 10
      }
    : {
        position: 'absolute',
        left: 0,
        right: 0,
        top: -geometry.overhangPixels,
        height: geometry.hitAreaPixels,
        background: 'transparent',
        zIndex: 10
      };

  const paneStyle: React.CSSProperties = horizontal
    ? { flexBasis: `${ratio}%`, flexGrow: 0, flexShrink: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
    : { flexBasis: `${ratio}%`, flexGrow: 0, flexShrink: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' };

  const secondPaneStyle: React.CSSProperties = horizontal
    ? { flex: '1 1 0%', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
    : { flex: '1 1 0%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' };

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        userSelect: dragging ? 'none' : undefined
      }}
    >
      <div style={paneStyle}>{children[0]}</div>
      <div
        className="eu-panel-divider"
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize panes"
        aria-valuenow={Math.round(ratio)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={`Drag to resize · double-click for 50% · ${horizontal ? '← →' : '↑ ↓'} to nudge, Home/End for the limits`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => applyRatio(RESET_RATIO)}
        onKeyDown={onKeyDown}
        // `.eu-panel-divider` supplies the resting and hover/focus colours; only
        // the active drag overrides it, so the CSS highlight keeps working.
        style={dragging ? { ...dividerStyle, background: 'var(--eu-accent)' } : dividerStyle}
      >
        {/* The part you can actually grab; the rule underneath stays 1px. */}
        <div aria-hidden="true" data-testid="split-divider-hit-area" style={hitAreaStyle} />
      </div>
      <div style={secondPaneStyle}>{children[1]}</div>
    </div>
  );
};

export default SplitPane;
