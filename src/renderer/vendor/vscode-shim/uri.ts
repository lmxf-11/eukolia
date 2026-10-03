/**
 * Eukolia — VS Code compatibility layer: `Uri`.
 * Ported semantics from the VS Code API; used by ported LaTeX Workshop code for
 * file identity, `joinPath`, `dirname` and `fsPath` conversions.
 */

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

export class Uri {
  public readonly scheme: string;
  public readonly authority: string;
  public readonly path: string;
  public readonly query: string;
  public readonly fragment: string;

  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static file(path: string): Uri {
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      // Windows drive letters: C:/foo -> /c%3A/foo
      const m = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
      if (m) {
        normalized = `/${m[1].toLowerCase()}%3A/${m[2]}`;
      } else {
        normalized = `/${normalized}`;
      }
    } else {
      const m = /^\/([a-zA-Z]):\/(.*)$/.exec(normalized);
      if (m) normalized = `/${m[1].toLowerCase()}%3A/${m[2]}`;
    }
    return new Uri('file', '', normalized, '', '');
  }

  static parse(value: string, strict = false): Uri {
    const match = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(value);
    if (!match) {
      if (strict) throw new Error(`Invalid URI: ${value}`);
      return Uri.file(value);
    }
    const scheme = match[2] ?? '';
    if (!scheme) {
      if (strict) throw new Error(`Missing scheme in URI: ${value}`);
      return Uri.file(value);
    }
    if (!SCHEME_PATTERN.test(scheme)) throw new Error(`Invalid scheme in URI: ${value}`);
    return new Uri(
      scheme.toLowerCase(),
      decodeURIComponent(match[4] ?? ''),
      match[5] ?? '',
      match[7] ?? '',
      match[9] ?? ''
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    if (base.scheme === 'file') {
      let p = base.fsPath;
      for (const segment of segments) {
        p = p.replace(/[\\/]+$/, '') + '/' + segment.replace(/^[\\/]+/, '');
      }
      return Uri.file(p);
    }
    const joined = [base.path.replace(/\/+$/, ''), ...segments.map((s) => s.replace(/^\/+/, ''))].join('/');
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }

  get fsPath(): string {
    if (this.scheme !== 'file') return this.path;
    let p = decodeURIComponent(this.path.replace(/^\/([a-zA-Z]%3A|([a-zA-Z]):)/, (_all, _g1, drive: string) => `${drive ?? _all[1]}:`));
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    if (/^[a-zA-Z]:/.test(p)) return p.replace(/\//g, '\\');
    return p;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }

  toString(): string {
    let result = `${this.scheme}:`;
    if (this.authority) result += `//${this.authority}`;
    result += this.path;
    if (this.query) result += `?${this.query}`;
    if (this.fragment) result += `#${this.fragment}`;
    return result;
  }

  toJSON(): string {
    return this.toString();
  }

  static isUri(value: unknown): value is Uri {
    return value instanceof Uri;
  }
}
