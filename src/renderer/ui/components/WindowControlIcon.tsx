import React from 'react';

/** Thin Windows caption glyphs, separate from the application's toolbar icons. */
export const WindowControlIcon: React.FC<{
  action: 'minimize' | 'maximize' | 'restore' | 'close';
}> = ({ action }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true" focusable="false">
    {action === 'minimize' && <path d="M1 6.5h10" />}
    {action === 'maximize' && <rect x="1.5" y="1.5" width="9" height="9" />}
    {action === 'restore' && <path d="M3.5 3.5v-2h7v7h-2 M1.5 3.5h7v7h-7z" />}
    {action === 'close' && <path d="m1 1 10 10M11 1 1 11" />}
  </svg>
);
