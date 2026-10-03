/**
 * Figure preview tests.
 *
 * `\includegraphics{plot.pdf}` is rendered by handing the figure's path to the
 * native PDF engine, which speaks in filesystem paths — so the URL-to-path
 * conversion and the pixel conversion are the two places where a mistake shows up
 * as a blank figure rather than an error. Both are pure and tested here.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFigureIndex,
  fileUrlToPath,
  isFigurePath,
  pathToFileUrl,
  pixelsToRgba
} from '../../src/renderer/services/figurePreview';

describe('fileUrlToPath', () => {
  it('strips the leading slash before a Windows drive letter', () => {
    expect(fileUrlToPath('file:///C:/project/plot.pdf')).toBe('C:/project/plot.pdf');
  });

  it('decodes percent-encoded characters', () => {
    expect(fileUrlToPath('file:///C:/my%20project/fig%201.pdf')).toBe('C:/my project/fig 1.pdf');
  });

  it('handles a POSIX-style absolute path', () => {
    expect(fileUrlToPath('file:///home/user/plot.pdf')).toBe('/home/user/plot.pdf');
  });

  it('preserves a UNC host', () => {
    expect(fileUrlToPath('file://server/share/plot.pdf')).toBe('//server/share/plot.pdf');
  });

  it('returns null for a non-file URL', () => {
    expect(fileUrlToPath('blob:https://example.test/abc')).toBeNull();
    expect(fileUrlToPath('data:application/pdf;base64,AAAA')).toBeNull();
    expect(fileUrlToPath('https://example.test/plot.pdf')).toBeNull();
  });
});

describe('pixelsToRgba', () => {
  it('passes RGBA through unchanged', () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = pixelsToRgba(source, 'rgba');
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('swaps BGRA to RGBA and keeps the alpha channel', () => {
    // One pixel: B=10, G=20, R=30, A=40 -> R=30, G=20, B=10, A=40
    const result = pixelsToRgba(new Uint8Array([10, 20, 30, 40]), 'bgra');
    expect(Array.from(result)).toEqual([30, 20, 10, 40]);
  });

  it('expands BGR to RGBA with an opaque alpha', () => {
    const result = pixelsToRgba(new Uint8Array([10, 20, 30]), 'bgr');
    expect(Array.from(result)).toEqual([30, 20, 10, 255]);
  });

  it('expands RGB to RGBA with an opaque alpha', () => {
    const result = pixelsToRgba(new Uint8Array([10, 20, 30]), 'rgb');
    expect(Array.from(result)).toEqual([10, 20, 30, 255]);
  });

  it('produces four channels for every source pixel', () => {
    const source = new Uint8Array(3 * 100);
    const rgba = pixelsToRgba(source, 'bgr');
    expect(rgba.length).toBe(4 * 100);
  });
});

describe('isFigurePath', () => {
  it('accepts the formats \\includegraphics supports', () => {
    for (const name of ['plot.pdf', 'shot.PNG', 'x.jpg', 'y.jpeg', 'z.svg', 'a.webp', 'b.eps']) {
      expect(isFigurePath(name), name).toBe(true);
    }
  });

  it('rejects other files', () => {
    for (const name of ['main.tex', 'refs.bib', 'notes.txt', 'noextension']) {
      expect(isFigurePath(name), name).toBe(false);
    }
  });
});

describe('pathToFileUrl', () => {
  it('produces a URL with three slashes for a Windows path', () => {
    expect(pathToFileUrl('C:\\project\\plot.pdf')).toBe('file:///C:/project/plot.pdf');
  });

  it('encodes spaces and other reserved characters per segment', () => {
    expect(pathToFileUrl('C:\\my project\\fig 1.pdf')).toBe('file:///C:/my%20project/fig%201.pdf');
  });

  it('round-trips through fileUrlToPath', () => {
    const original = 'C:\\my project\\fig 1.pdf';
    expect(fileUrlToPath(pathToFileUrl(original))).toBe('C:/my project/fig 1.pdf');
  });
});

describe('buildFigureIndex', () => {
  const files = [
    { path: 'C:\\proj\\main.tex', relativePath: 'main.tex', isDirectory: false },
    { path: 'C:\\proj\\figures\\plot.pdf', relativePath: 'figures/plot.pdf', isDirectory: false },
    { path: 'C:\\proj\\logo.png', relativePath: 'logo.png', isDirectory: false },
    { path: 'C:\\proj\\figures', relativePath: 'figures', isDirectory: true }
  ];

  it('indexes every image under its relative path, basename and absolute path', () => {
    const index = buildFigureIndex(files);
    expect(index['figures/plot.pdf']?.extension).toBe('pdf');
    expect(index['plot.pdf']?.extension).toBe('pdf');
    expect(index['C:/proj/figures/plot.pdf']?.extension).toBe('pdf');
    expect(index['logo.png']?.extension).toBe('png');
  });

  it('skips non-images and directories', () => {
    const index = buildFigureIndex(files);
    expect(index['main.tex']).toBeUndefined();
    expect(index['figures']).toBeUndefined();
  });

  it('gives every entry a loadable file URL', () => {
    const index = buildFigureIndex(files);
    expect(index['logo.png']?.url).toBe('file:///C:/proj/logo.png');
  });

  it('keeps the first entry when two files share a basename', () => {
    const index = buildFigureIndex([
      { path: 'C:\\proj\\a\\plot.pdf', relativePath: 'a/plot.pdf', isDirectory: false },
      { path: 'C:\\proj\\b\\plot.pdf', relativePath: 'b/plot.pdf', isDirectory: false }
    ]);
    expect(index['plot.pdf']?.url).toBe('file:///C:/proj/a/plot.pdf');
  });

  it('accepts a leading ./-prefixed lookup key', () => {
    const index = buildFigureIndex(files);
    expect(index['./figures/plot.pdf']?.url).toBe('file:///C:/proj/figures/plot.pdf');
  });
});
