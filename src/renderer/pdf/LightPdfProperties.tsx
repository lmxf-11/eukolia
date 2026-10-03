/**
 * Eukolia — light-pdf's "Document Properties" window, drawn.
 *
 * `LightProperties.cpp` shows a scrollable list of `Label: value` rows plus a
 * "Copy To Clipboard" button (`LightProperties.cpp:870`). The rows themselves
 * come from `lightpdf-properties.ts`; this component renders them over the pane
 * and closes on Escape, as the dialog does.
 */

import React, { useCallback } from 'react';

import { documentPropertyRows, documentPropertyText } from './lightpdf-properties';
import {
  accentColor,
  bgrToHex,
  themeControlBackgroundColor,
  themeWindowTextColor,
  type LightPdfThemeState
} from './lightpdf-theme';
import type { PdfOpenResult } from '../../shared/ipc';

export interface LightPdfPropertiesProps {
  info: Pick<PdfOpenResult, 'path' | 'pageCount' | 'pages' | 'metadata'>;
  currentPage: number;
  theme: LightPdfThemeState;
  onClose(): void;
}

export const LightPdfProperties: React.FC<LightPdfPropertiesProps> = (props) => {
  const { theme } = props;
  const rows = documentPropertyRows(props.info, props.currentPage);

  const controlBg = themeControlBackgroundColor(theme);
  const textColor = bgrToHex(themeWindowTextColor(theme));
  const edgeColor = bgrToHex(accentColor(controlBg, 40));
  const hotColor = bgrToHex(accentColor(controlBg, 20));

  const copyToClipboard = useCallback(() => {
    void navigator.clipboard?.writeText(documentPropertyText(rows));
  }, [rows]);

  return (
    <div
      data-testid="pdf-properties"
      role="dialog"
      aria-label="Document Properties"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.25)'
      }}
    >
      <div
        style={{
          minWidth: 360,
          maxWidth: '85%',
          maxHeight: '85%',
          display: 'flex',
          flexDirection: 'column',
          background: bgrToHex(controlBg),
          border: `1px solid ${edgeColor}`,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
          color: textColor,
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          fontSize: 12
        }}
      >
        <div style={{ padding: '4px 8px', borderBottom: `1px solid ${edgeColor}`, fontWeight: 600 }}>
          Document Properties
        </div>
        {/* `LightProperties.cpp` lays the rows out label-first; the label column
            is aligned so the values line up, as `GetPropertyLabelWidth` does. */}
        <div data-testid="pdf-properties-rows" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 8px' }}>
          {rows.map((row) => (
            <div key={row.label} style={{ display: 'flex', gap: 8, padding: '1px 0' }}>
              <span style={{ flexShrink: 0, fontWeight: 600 }}>{row.label}</span>
              <span style={{ wordBreak: 'break-word' }}>{row.value}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, padding: 6, borderTop: `1px solid ${edgeColor}` }}>
          <button
            type="button"
            data-testid="pdf-properties-copy"
            onClick={copyToClipboard}
            style={{
              padding: '3px 10px',
              border: `1px solid ${edgeColor}`,
              borderRadius: 2,
              background: 'transparent',
              color: textColor,
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer'
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = hotColor;
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
            }}
          >
            Copy To Clipboard
          </button>
          <button
            type="button"
            data-testid="pdf-properties-close"
            onClick={props.onClose}
            style={{
              padding: '3px 10px',
              border: `1px solid ${edgeColor}`,
              borderRadius: 2,
              background: 'transparent',
              color: textColor,
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer'
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = hotColor;
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
