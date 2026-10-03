/**
 * ScrollArea — the scrolling surface used by every long list in Eukolia.
 *
 * The wheel belongs to `core/smoothScroll`, which owns it for the whole shell.
 * This component is the box that module glides: it marks the element as a scroll
 * container, keeps the scrollbar styling every list shares, and exposes the
 * imperative `scrollTo` a list needs to keep a highlighted row in view. What is
 * left here is deliberately small — a second wheel implementation is what made
 * "smooth" mean two different things in two different panels.
 *
 * Nothing about that contract is a *style*, which is why this file changed less
 * than its neighbours in the panel work: the two attributes the module and the
 * shell's stylesheets key off are the component's public surface, and the panel's
 * own rows, bands and status lines are styled from `panel-surfaces.css` without
 * the box having to know what is inside it.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { NATIVE_SCROLL_ATTRIBUTE, scrollElementTo, stopScrollAnimation } from '../../core/smoothScroll';

export interface ScrollAreaHandle {
  /** Jumps (or animates) to a vertical offset, clamped to the scrollable range. */
  scrollTo(top: number, animated?: boolean): void;
  /** The underlying element, for measuring and for `scrollIntoView` on children. */
  getElement(): HTMLDivElement | null;
}

export interface ScrollAreaProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /**
   * A stable handle for tests and for the end-to-end probe.
   *
   * The panel's five views are one component switching its body, so "the panel is
   * open" says nothing about *which* view rendered; a per-view id is what lets a
   * check assert that the view the user selected is the one on screen.
   */
  testId?: string;
  /** `false` leaves this box to the browser's own wheel handling. */
  smooth?: boolean;
  onScroll?(top: number): void;
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Optional handle so callers can drive the scroll position imperatively. */
  handleRef?: React.MutableRefObject<ScrollAreaHandle | null>;
}

export const ScrollArea: React.FC<ScrollAreaProps> = ({ children, className, style, testId, smooth = true, onScroll, scrollRef, handleRef }) => {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  const scrollTo = useCallback(
    (top: number, animated = false) => {
      const element = elementRef.current;
      if (!element) return;
      // `smooth={false}` means the box has no animation of its own either, which
      // is the same promise the browser would make for it.
      scrollElementTo(element, top, { axis: 'y', animated: animated && smooth });
    },
    [smooth]
  );

  const assignElement = useCallback(
    (node: HTMLDivElement | null) => {
      elementRef.current = node;
      if (scrollRef) scrollRef.current = node;
    },
    [scrollRef]
  );

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { scrollTo, getElement: () => elementRef.current };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, scrollTo]);

  // A glide must not outlive the element it is moving.
  useEffect(() => {
    const element = elementRef.current;
    return () => {
      if (element) stopScrollAnimation(element);
    };
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    onScrollRef.current?.(event.currentTarget.scrollTop);
  }, []);

  const mergedStyle = useMemo<React.CSSProperties>(
    () => ({
      // Stated inline as well as in `index.css`, because these are what make the
      // box a scroll container *at all*: the wheel handler in `core/smoothScroll`
      // discovers a surface by its computed overflow, so a box that has not yet
      // been reached by the stylesheet would be one it cannot move. `...style`
      // last, so a caller's own measurements still win over these defaults.
      overflow: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--eu-border-strong) transparent',
      ...style
    }),
    [style]
  );

  return (
    <div
      ref={assignElement}
      // Three contracts, and all three matter:
      //  - `eu-scroll` is the styling hook (`.eu-scroll` in `index.css` and the
      //    design system) and is always present, so a caller's className adds to
      //    it rather than replacing it;
      //  - `data-scroll` is the same hook for CSS and for the smoke tests, which
      //    address a panel's scroller as `[data-scroll]`;
      //  - `NATIVE_SCROLL_ATTRIBUTE` is the *opt-out* — the one attribute
      //    `smoothScroll` looks for by name — and is written only when the caller
      //    asked for the browser's own wheel handling.
      className={className ? `eu-scroll ${className}` : 'eu-scroll'}
      data-scroll="true"
      data-testid={testId}
      {...(smooth ? {} : { [NATIVE_SCROLL_ATTRIBUTE]: 'true' })}
      style={mergedStyle}
      onScroll={handleScroll}
    >
      {children}
    </div>
  );
};

export default ScrollArea;
