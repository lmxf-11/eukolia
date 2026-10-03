/**
 * Eukolia — narrow `require` compatibility shim for the renderer.
 *
 * The LaTeX Workshop parser is vendored verbatim from the extension's
 * `resources/unified.js`, which is a Node bundle: at module scope it executes
 * `const path = require("path")`. In VS Code that is fine; in Eukolia's renderer
 * there is no CommonJS loader, so importing the bundle would throw
 * `ReferenceError: require is not defined`.
 *
 * Rather than rewriting the vendored parser, this file installs a `require` that
 * resolves **exactly one** module — `path` — and throws for everything else.
 * Nothing here grants filesystem, process or module access, so the security
 * posture of the renderer is unchanged (Instructions.md §68): a snippet or a
 * vendored bundle still cannot load arbitrary Node modules.
 *
 * Loaded from `index.html` before the application module so it is in place
 * before any import is evaluated.
 */
(function installEukoliaRequireShim() {
  'use strict';

  if (typeof globalThis.require === 'function') return;

  var WIN32 = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || navigator.platform || '');
  var SEP = WIN32 ? '\\' : '/';
  var DELIMITER = WIN32 ? ';' : ':';

  function isAbsolute(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.charCodeAt(0) === 47 /* / */) return true;
    return WIN32 && value.length > 2 && /^[a-zA-Z]:[\\/]/.test(value);
  }

  function normalize(value) {
    if (typeof value !== 'string' || value.length === 0) return '.';
    var unified = value.replace(/\\/g, '/');
    var prefix = '';
    if (/^[a-zA-Z]:/.test(unified)) {
      prefix = unified.slice(0, 2);
      unified = unified.slice(2);
    }
    var absolute = unified.charAt(0) === '/';
    var trailingSlash = unified.length > 1 && unified.charAt(unified.length - 1) === '/';

    var parts = unified.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else if (!absolute) out.push('..');
        continue;
      }
      out.push(part);
    }

    var result = out.join('/');
    if (absolute) result = '/' + result;
    if (prefix) result = prefix + result;
    if (result === '') result = absolute ? '/' : '.';
    if (trailingSlash && result !== '/' && !/\/$/.test(result)) result += '/';
    return WIN32 ? result.replace(/\//g, '\\') : result;
  }

  function resolve() {
    var resolved = '';
    var absolute = false;
    for (var i = arguments.length - 1; i >= 0 && !absolute; i--) {
      var segment = arguments[i];
      if (typeof segment !== 'string' || segment.length === 0) continue;
      resolved = resolved ? segment + '/' + resolved : segment;
      absolute = isAbsolute(segment);
    }
    if (!absolute) {
      // The renderer has no real working directory; the document root stands in
      // for it, which is what the vendored parser means by "the project".
      var cwd = (typeof globalThis.__eukoliaCwd === 'string' && globalThis.__eukoliaCwd) || '/';
      resolved = resolved ? cwd + '/' + resolved : cwd;
    }
    return normalize(resolved);
  }

  function join() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var segment = arguments[i];
      if (typeof segment === 'string' && segment.length > 0) parts.push(segment);
    }
    return parts.length === 0 ? '.' : normalize(parts.join('/'));
  }

  function dirname(value) {
    if (typeof value !== 'string' || value.length === 0) return '.';
    var normalized = normalize(value);
    var unified = normalized.replace(/\\/g, '/').replace(/\/+$/, '');
    var index = unified.lastIndexOf('/');
    if (index === -1) return '.';
    if (index === 0) return '/';
    var head = unified.slice(0, index);
    if (/^[a-zA-Z]:$/.test(head)) return head + SEP;
    return WIN32 ? head.replace(/\//g, '\\') : head;
  }

  function basename(value, suffix) {
    if (typeof value !== 'string' || value.length === 0) return '';
    var unified = value.replace(/\\/g, '/').replace(/\/+$/, '');
    var index = unified.lastIndexOf('/');
    var base = index === -1 ? unified : unified.slice(index + 1);
    if (suffix && base.length > suffix.length && base.slice(-suffix.length) === suffix) {
      return base.slice(0, base.length - suffix.length);
    }
    return base;
  }

  function extname(value) {
    var base = basename(value);
    var index = base.lastIndexOf('.');
    return index <= 0 ? '' : base.slice(index);
  }

  function parse(value) {
    var base = basename(value);
    var extension = extname(base);
    var directory = dirname(value);
    return {
      root: isAbsolute(value) ? (WIN32 ? dirname(value).replace(/[^\\/]*$/, '') : '/') : '',
      dir: directory === '.' && !isAbsolute(value) ? '' : directory,
      base: base,
      ext: extension,
      name: extension ? base.slice(0, base.length - extension.length) : base
    };
  }

  function format(descriptor) {
    var directory = descriptor.dir || descriptor.root || '';
    var base = descriptor.base || (descriptor.name || '') + (descriptor.ext || '');
    if (!directory) return base;
    return directory.charAt(directory.length - 1) === SEP ? directory + base : directory + SEP + base;
  }

  function relative(from, to) {
    var fromParts = normalize(resolve(from)).replace(/\\/g, '/').split('/').filter(Boolean);
    var toParts = normalize(resolve(to)).replace(/\\/g, '/').split('/').filter(Boolean);
    var common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
    var up = new Array(fromParts.length - common).fill('..');
    var down = toParts.slice(common);
    var result = up.concat(down).join('/');
    return WIN32 ? result.replace(/\//g, '\\') : result;
  }

  var pathModule = {
    resolve: resolve,
    normalize: normalize,
    isAbsolute: isAbsolute,
    join: join,
    relative: relative,
    dirname: dirname,
    basename: basename,
    extname: extname,
    format: format,
    parse: parse,
    toNamespacedPath: function (value) {
      return value;
    },
    matchesGlob: function () {
      return false;
    },
    sep: SEP,
    delimiter: DELIMITER
  };

  // `path.posix` / `path.win32` are read by a few call sites; both are served by
  // the same implementation because the vendored parser only uses them to split
  // separators consistently.
  pathModule.posix = pathModule;
  pathModule.win32 = pathModule;
  pathModule.default = pathModule;

  var ALLOWED = { path: pathModule, 'node:path': pathModule };

  function shimRequire(id) {
    if (Object.prototype.hasOwnProperty.call(ALLOWED, id)) return ALLOWED[id];
    throw new Error(
      '[eukolia] require("' +
        id +
        '") is not available in the renderer. Only "path" is provided, for the vendored LaTeX parser.'
    );
  }

  shimRequire.resolve = function (id) {
    if (Object.prototype.hasOwnProperty.call(ALLOWED, id)) return id;
    throw new Error('[eukolia] require.resolve("' + id + '") is not available in the renderer.');
  };

  Object.defineProperty(globalThis, 'require', {
    value: shimRequire,
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
