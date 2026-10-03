import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  type EusnipsFile,
  type EusnipsSnippet,
  uniqueSnippetId,
  escapeRegexText,
  normalizeSnippetFile
} from '../../src/renderer/snippets/eusnips/model';
import { validateSnippetFile } from '../../src/renderer/snippets/eusnips/validate';
import { loadEusnipsIntoEngine } from '../../src/renderer/snippets/eusnips/hsnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';

export function translateHsnips(hsnipsContent: string, existingUserSnippets: EusnipsFile | null = null): EusnipsFile {
  const lines = hsnipsContent.split(/\r?\n/);

  let inGlobal = false;
  const globalLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('global')) {
      inGlobal = true;
      continue;
    }
    if (line.startsWith('endglobal')) {
      inGlobal = false;
      continue;
    }
    if (inGlobal) {
      globalLines.push(line);
    }
  }

  const existingByPatternAndBody = new Map<string, string>();
  const existingByPatternAndDesc = new Map<string, string>();
  const existingByPattern = new Map<string, string[]>();

  if (existingUserSnippets && Array.isArray(existingUserSnippets.snippets)) {
    for (const s of existingUserSnippets.snippets) {
      if (!s.id) continue;
      const p = s.trigger?.pattern ?? '';
      const b = typeof s.body === 'string' ? s.body : '';
      const d = s.description || '';
      
      const pbKey = `${p} ::: ${b}`;
      if (!existingByPatternAndBody.has(pbKey)) {
        existingByPatternAndBody.set(pbKey, s.id);
      }

      const pdKey = `${p} ::: ${d}`;
      if (!existingByPatternAndDesc.has(pdKey)) {
        existingByPatternAndDesc.set(pdKey, s.id);
      }

      if (!existingByPattern.has(p)) {
        existingByPattern.set(p, []);
      }
      existingByPattern.get(p)!.push(s.id);

      if (p.startsWith('(\\$)?(?<!\\.)(\\s*,|\\s+)')) {
        const suffix = p.slice('(\\$)?(?<!\\.)(\\s*,|\\s+)'.length);
        const spaceP = '(\\$)?(?<!\\.)(\\s+)' + suffix;
        const commaP = '(\\$)?(?<!\\.)(\\s*),' + suffix;
        if (!existingByPattern.has(spaceP)) existingByPattern.set(spaceP, []);
        existingByPattern.get(spaceP)!.push(s.id);
        if (!existingByPattern.has(commaP)) existingByPattern.set(commaP, []);
        existingByPattern.get(commaP)!.push(s.id);
      }
    }
  }

  const assignedIds = new Set<string>();
  const snippets: EusnipsSnippet[] = [];

  let curPriority = 0;
  let inSnippet = false;
  let curSnippet: { meta: EusnipsSnippet; bodyLines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('global')) {
      inGlobal = true;
      continue;
    }
    if (line.startsWith('endglobal')) {
      inGlobal = false;
      continue;
    }
    if (inGlobal) continue;

    if (!inSnippet && line.startsWith('#')) {
      continue;
    }

    if (!inSnippet && line.startsWith('priority ')) {
      const parsedPriority = parseInt(line.slice('priority '.length).trim(), 10);
      if (!isNaN(parsedPriority)) {
        curPriority = parsedPriority;
      }
      continue;
    }

    if (!inSnippet && line.startsWith('snippet')) {
      const match = line.match(/^snippet ?(?:`([^`]+)`|(\S+))?(?: "((?:[^"\\]|\\.)*)")?(?: ([AMiwbmhn]*))?/);
      if (!match) continue;

      inSnippet = true;
      const isRegex = match[1] !== undefined;
      const rawTrigger = match[1] ?? match[2] ?? '';
      const description = match[3] ? match[3].replace(/\\(["\\])/g, '$1') : undefined;
      const flags = match[4] || '';

      const pattern = isRegex ? rawTrigger : escapeRegexText(rawTrigger);

      const snippetObj: EusnipsSnippet = {
        id: '',
        trigger: { pattern },
        body: '',
      };

      if (description) snippetObj.description = description;
      if (curPriority !== 0 && curPriority !== 100) snippetObj.priority = curPriority;
      if (flags.includes('A')) snippetObj.expand = 'auto';

      if (flags.includes('i')) {
        snippetObj.boundary = 'anywhere';
      } else if (flags.includes('w')) {
        snippetObj.boundary = 'word';
      } else if (flags.includes('b')) {
        snippetObj.boundary = 'line-start';
      }

      if (flags.includes('m') && !flags.includes('n')) {
        snippetObj.context = 'math';
      } else if (flags.includes('n') && !flags.includes('m')) {
        snippetObj.context = 'text';
      }

      if (flags.includes('h')) snippetObj.hidden = true;
      if (flags.includes('M')) snippetObj.multiline = true;

      curSnippet = {
        meta: snippetObj,
        bodyLines: [],
      };

      curPriority = 0;
      continue;
    }

    if (inSnippet) {
      if (line.startsWith('endsnippet')) {
        inSnippet = false;
        const body = curSnippet!.bodyLines.join('\n');
        curSnippet!.meta.body = body;

        const p = curSnippet!.meta.trigger.pattern;
        const d = curSnippet!.meta.description || '';
        const pbKey = `${p} ::: ${body}`;
        const pdKey = `${p} ::: ${d}`;

        let id = '';
        if (existingByPatternAndBody.has(pbKey) && !assignedIds.has(existingByPatternAndBody.get(pbKey)!)) {
          id = existingByPatternAndBody.get(pbKey)!;
        } else if (existingByPatternAndDesc.has(pdKey) && !assignedIds.has(existingByPatternAndDesc.get(pdKey)!)) {
          id = existingByPatternAndDesc.get(pdKey)!;
        } else if (existingByPattern.has(p)) {
          const candidates = existingByPattern.get(p)!;
          const available = candidates.find((c) => !assignedIds.has(c));
          if (available) id = available;
        }

        if (!id) id = uniqueSnippetId(assignedIds);

        assignedIds.add(id);
        curSnippet!.meta.id = id;

        snippets.push(curSnippet!.meta);
        curSnippet = null;
        continue;
      }
      curSnippet!.bodyLines.push(line);
    }
  }

  return {
    version: 1,
    name: 'LaTeX snippets',
    description: 'Translated from VS Code latex.hsnips into EUSnips JSON schema.',
    namespace: 'latex',
    language: 'latex',
    defaults: {
      priority: 100,
      expand: 'manual',
      boundary: 'whitespace',
      hidden: false,
      multiline: false,
      context: 'any',
      enabled: true,
    },
    globals: {
      javascript: globalLines.join('\n'),
    },
    snippets,
  };
}

export function mergeAndSimplifySnippets(originalFile: EusnipsFile): EusnipsFile {
  const result: EusnipsFile = JSON.parse(JSON.stringify(originalFile));


  // 1. Enrich globals.javascript with shared helpers and lookup tables
  const additionalGlobals = `
// =============================================================================
// Merged & Simplified Snippet Helpers & Lookup Tables
// =============================================================================

var GREEK = {
  a: 'alpha', b: 'beta', g: 'gamma', G: 'Gamma', d: 'delta', D: 'Delta',
  e: 'epsilon', ve: 'varepsilon', z: 'zeta', th: 'theta', vt: 'vartheta', vth: 'vartheta',
  Th: 'Theta', i: 'iota', k: 'kappa', l: 'lambda', L: 'Lambda', m: 'mu', n: 'nu',
  x: 'xi', X: 'Xi', pi: 'pi', Pi: 'Pi', vpi: 'varpi', r: 'rho', vr: 'varrho',
  s: 'sigma', S: 'Sigma', vs: 'varsigma', ta: 'tau', u: 'upsilon', U: 'Upsilon',
  ph: 'phi', vph: 'varphi', Ph: 'Phi', ch: 'chi', ps: 'psi', Ps: 'Psi', o: 'omega', O: 'Omega'
};

var ACCENT_MAP = { bre: 'breve', til: 'tilde' };

var ENV_MAP = {
  aln: 'align', gth: 'gather', eqt: 'equation', mtl: 'multline', thrm: 'theorem',
  crl: 'corollary', lmm: 'lemma', exmp: 'example', rmk: 'remark', dfn: 'definition',
  prf: 'proof', fgr: 'figure', arr: 'array', tikz: 'tikzcd', vbt: 'verbatim', abtr: 'abstract'
};

function buildMatrixGrid(m) {
  const env = (m[2] || "p") + "matrix";
  const rows = parseInt(m[3], 10);
  const cols = parseInt(m[5], 10);
  let res = "\\\\begin{" + env + "}\\n";
  let tabIdx = 1;
  for (let r = 0; r < rows; r++) {
    let rowStr = "  ";
    for (let c = 0; c < cols; c++) {
      rowStr += "$" + (tabIdx++);
      if (c < cols - 1) rowStr += " & ";
    }
    if (r < rows - 1) rowStr += " \\\\\\\\";
    res += rowStr + "\\n";
  }
  res += "\\\\end{" + env + "}";
  return res;
}

function formatScript(m, type) {
  const isText = !!m[1];
  const prefix = m[3] || "";
  const arg = m[4] || "";
  const sym = type === "sub" ? "_" : "^";
  let content = arg ? "{" + arg + "}" : "{$1}";
  let out = prefix + sym + content;
  if (isText) return out + "\\$ ";
  return out;
}

function formatFraction(m) {
  const isText = !!m[1];
  const isDfrac = m[3] === "//";
  const cmd = isDfrac ? "\\\\dfrac" : "\\\\frac";
  const out = cmd + "{$1}{$2}$0";
  if (isText) return " " + "\\$" + out + "\\$ ";
  return out;
}

function formatSqrt(m) {
  const isText = !!m[1];
  const arg = m[3] || ("$" + "{1:" + "$" + "{VISUAL}}");
  const sub = m[4] ? "_" + m[4] : "";
  const out = "\\\\sqr{" + arg + "}" + sub;
  if (isText) return " " + "\\$" + out + "\\$ ";
  return out + "$0";
}

var ALIGN_OPS = {
  '=': '=',
  '<': '<',
  '>': '>',
  'g': '\\\\geq',
  'l': '\\\\leq',
  'n': '\\\\neq',
  '+': '+',
  '-': '-'
};

var CAT_MAP = {
  PreO: 'PreOrd',
  FinS: 'FinSet',
  FinV: 'FinVect',
  CompH: 'CompHaus',
  'B \\\\oo l': 'Bool'
};

var ARROW_MAP = {

  '<->': 'leftrightarrow',
  '<-->': 'longleftrightarrow',
  '<=>': 'Iff',
  '<==>': 'iff',
  '=>': 'To',
  '==>': 'Longrightarrow',
  '<=': 'Impliedby',
  '<==': 'Longleftarrow',
  '->': 'to',
  '-->': 'longrightarrow',
  '<-': 'leftarrow',
  '<--': 'longleftarrow',
  '|->': 'mapsto',
  '|-->': 'longmapsto'
};

function openInlineMath(match, content = "") {
  return match[1] ? content : match[2] + "\\\\$" + content;
}

function displayMathPrefix(match) {
  if (match && typeof match[2] !== "undefined" && match[2] !== "") {
    const math = match[2].replace(/\\$/g, "\\\\$");
    return match[1] + math + "\\n" + match[1];
  }
  return (match && match[1]) || "";
}

function splitInlineDelimiter(raw = "") {
  const comma = raw.endsWith(",");
  return {
    whitespace: comma ? raw.slice(0, -1) : raw,
    comma: comma ? "," : ""
  };
}

function openInlineMathDelimited(match, delimiterIndex = 2, dollarIndex = 1) {
  const delimiter = splitInlineDelimiter(match[delimiterIndex] || "");
  const opening = match[dollarIndex] ? "" : delimiter.whitespace + "\\\\$";
  return opening + delimiter.comma;
}

var GREEK_REGEX = /^(?:mu|alpha|sigma|rho|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)('*)?$/;

function renderDecoratedAtom(style, atom, accent, prefix = "") {
  let value = prefix;
  const isGreek = atom && GREEK_REGEX.test(atom);
  const atomText = isGreek ? "\\\\" + atom : (atom || "");
  value += style ? "\\\\" + style + "{" + atomText + "}" : atomText;
  return accent ? "\\\\" + accent + "{" + value + "}" : value;
}

function renderBinaryAuto(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  if (mode === "command") {
    out += " \\\\" + op + " ";
  } else if (mode === "symbol") {
    out += " " + op + " ";
  } else {
    out += op;
  }

  out += renderDecoratedAtom(match[8], match[9], match[11]);
  return out + "$" + (match[12] || "");
}

function renderSimpleCommandBinary(match) {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\\\$";
  out += renderDecoratedAtom(match[3], match[4], null, delimiter.comma);
  out += " \\\\" + (match[6] || "") + " ";
  out += renderDecoratedAtom(match[7], match[8], null);
  return out + "$" + (match[10] || "");
}

function renderFunctionBinary(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  out += mode === "command" ? " \\\\" + op + " " : " " + op + " ";
  out += "\\\\" + (match[8] || "") + "(";
  out += renderDecoratedAtom(match[9], match[10], match[12]);
  return out + ")$" + (match[13] || "");
}

function renderFunctionTabstopBinary(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  out += mode === "command" ? " \\\\" + op + " " : " " + op + " ";

  const fn = match[8] || "";
  const sep = match[9] || "";
  if (sep === " ") {
    return out + "\\\\" + fn + " $1$ ";
  } else {
    return out + "\\\\" + fn + "($1)$ ";
  }
}
`;

  const existingGlobals = typeof result.globals?.javascript === 'string'
    ? result.globals.javascript
    : Array.isArray(result.globals?.javascript)
      ? result.globals.javascript.join('\n')
      : '';

  result.globals = {
    ...result.globals,
    javascript: existingGlobals.trimEnd() + '\n' + additionalGlobals.trimStart()
  };

  // 2. Identify and filter out individual snippets to be replaced
  const greekMathTriggers = new Set([
    '@a', '@b', '@g', '@G', '@d', '@D', '@e', '@ve', '@z', '@th', '@vt', '@vth',
    '@Th', '@i', '@k', '@l', '@L', '@m', '@n', '@x', '@X', '@pi', '@Pi', '@vpi',
    '@r', '@vr', '@s', '@S', '@vs', '@ta', '@u', '@U', '@ph', '@vph', '@Ph',
    '@ch', '@ps', '@Ps', '@o', '@O'
  ]);

  const greekTextTriggers = new Set([
    ' @a', ' @b', ' @g', ' @G', ' @d', ' @D', ' @e', ' @ve', ' @z', ' @th', ' @vt', ' @vth',
    ' @Th', ' @i', ' @k', ' @l', ' @L', ' @m', ' @n', ' @x', ' @X', ' @pi', ' @Pi', ' @vpi',
    ' @r', ' @vr', ' @s', ' @S', ' @vs', ' @ta', ' @u', ' @U', ' @ph', ' @vph', ' @Ph',
    ' @ch', ' @ps', ' @Ps', ' @o', ' @O'
  ]);

  const catMathTriggers = new Set([
    'Set ', 'Set\\*', 'Grp ', 'Ab ', 'Vect ', 'Vec ', 'Matr ', 'Top ', 'Toph ', 'Toph\\*',
    'Top\\*', 'Ring ', 'CRing ', 'CAlg ', 'Alg ', 'Rng ', 'Mod ', 'SMod ', 'Mon ', 'CMon ',
    'Poset ', 'Graph ', 'CW ', 'hCW ', 'Diff ', 'Man ', 'Met ', 'Hilb ', 'Ban ', 'Field ',
    'FinSet ', 'Rel ', 'Cat ', 'CAT ', 'Ord ', 'Simp ', 'Sp ', 'Ens ', 'Pos ', 'PreO ',
    'Hask ', 'Cob ', 'FinS ', 'FinV ', 'Meas ', 'Sch ', 'Bimod ', 'Haus ', 'CompH ',
    'PL ', 'Lat ', 'B \\\\oo l ', 'Heyt ', 'Type ', 'Asm ', 'AffSch ', 'Aff ', 'Var ',
    'SmVar ', 'AffVar ', 'ProjVar '
  ]);

  const alignOpTriggers = new Set([';=', ';<', ';>', ';g', ';l', ';n', ';+', ';-']);
  const spacingOpTriggers = new Set(['(.)\\+', '(.)\\-', '(.)\\<', '(.)\\>', '(.)\\=', '(.)\\~', '(.):']);
  const subDoubleTriggers = new Set([
    'aa', 'ii', 'jj', 'kk', 'mm', 'nn', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'xx', 'yy', 'zz'
  ]);

  const pdMathTriggers = new Set(['pd1', 'pd2', 'pd3', 'pdn']);
  const pdTextTriggers = new Set([
    '(\\$)?(?<!\\.)(\\s+)pd1 ', '(\\$)?(?<!\\.)(\\s+)pd2 ', '(\\$)?(?<!\\.)(\\s+)pd3 ', '(\\$)?(?<!\\.)(\\s+)pdn '
  ]);
  const ddMathTriggers = new Set(['dd1', 'dd2', 'dd3', 'ddn']);
  const ddTextTriggers = new Set([
    '(\\$)?(?<!\\.)(\\s+)dd1 ', '(\\$)?(?<!\\.)(\\s+)dd2 ', '(\\$)?(?<!\\.)(\\s+)dd3 ', '(\\$)?(?<!\\.)(\\s+)ddn '
  ]);

  const integralMathTriggers = new Set(['int', '2int', '3int', 'oint']);
  const integralTextTriggers = new Set([
    '(\\$)?(?<!\\.)(\\s+)int ', '(\\$)?(?<!\\.)(\\s+)2int ', '(\\$)?(?<!\\.)(\\s+)3int ', '(\\$)?(?<!\\.)(\\s+)oint '
  ]);

  const bracketMathTriggers = new Set(['a"', 'n"', 's"', 'p"', 'b"', 'g"']);
  const bracketTextTriggers = new Set([
    '(\\$)?(?<!\\.)(\\s+)a"', '(\\$)?(?<!\\.)(\\s+)n"', '(\\$)?(?<!\\.)(\\s+)s"',
    '(\\$)?(?<!\\.)(\\s+)p"', '(\\$)?(?<!\\.)(\\s+)b"', '(\\$)?(?<!\\.)(\\s+)g"'
  ]);

  const fontManualTriggers = new Set([
    'bb ', 'cal ', 'scr ', 'bf ', 'bm ', 'rm ', 'sf ', 'tt ', 'frk ', 'ds ', 'bs '
  ]);
  const fontSymbolTriggers = new Set([
    'bb([0-9a-zA-Z])', 'bf([0-9a-zA-Z])', 'bm([0-9a-zA-Z])', 'rm([0-9a-zA-Z])',
    'sf([0-9a-zA-Z])', 'tt([0-9a-zA-Z])', 'frk([0-9a-zA-Z])', 'ds([0-9a-zA-Z])', 'bs([0-9a-zA-Z])'
  ]);
  const fontCalScrTriggers = new Set([
    'cal([A-Z])', 'scr([A-Z])'
  ]);
  const fontPostfixTriggers = new Set([
    '([a-zA-Z]+)bb', '([a-zA-Z]+)cal', '([a-zA-Z]+)scr', '([a-zA-Z]+)bf', '([a-zA-Z]+)bm',
    '([a-zA-Z]+)rm', '([a-zA-Z]+)sf', '([a-zA-Z]+)frk', '([a-zA-Z]+)ds', '([a-zA-Z]+)bs'
  ]);

  const postfixAccentTriggers = new Set([
    'p3y726', 'd4bcg6', 'qaachc', 'cu8tz6', 'ig57yr', '7eg8wr', 'wh9i9w', 'kf77mu', '62wyk3', 'n6u8qi'
  ]);
  const dotsVariantTriggers = new Set(['k79n9s', '5u3ff4', 'u4s99v', 'netu3m', '5jf47j']);
  const unitVectorTriggers = new Set(['wasbvz', 'u8x8g6', '7vgyhm']);
  const powerTriggers = new Set(['59ws5e', 'w8nezb', '4kqxth']);
  const inverseTrigTextTriggers = new Set(['iaewm2', '3fcgtk', 'bzavyp']);

  const envGenericTriggers = new Set([
    'peszcd', 'k95xgk', 'erxtrg', 'wd65qa', 'rwurmj', 'zmivxc', '3bpdey', '2vnjzs', 'njwz4d', 'fgnkjv',
    '4v84wh', '65g55g', 'hfv4ps', 'zwie3g', 'r2gzfv', 's6ysyb', 'cq69cu', 'egmguy', 'xx6vcy', '3dvyqe',
    'bcez95', 'b5yujt', 'e4bh64', 'usi8xc', 'azva2g'
  ]);
  const matrixGridTriggers = new Set(['gqtmmp', '33e2x5']);
  const scriptSubSuperTriggers = new Set(['fvt5eu', 'qgz5wz', 'jgpfwi', 'a68fh5', 'kthr8p', 'rww865', 'rfc23y', '8z5peb', 'wcybvr', 'zsvd9i', 'gns8ng', '6ndzre']);
  const fractionManualTriggers = new Set(['2yfp5b', 'j8t7bm', 'zwt9mx', 'z2b87d']);
  const rootsManualTriggers = new Set(['a5bhfv', 'qihdxf', 'nxyn44', '8xdwer']);
  const autoSubscriptTextTriggers = new Set(['ptbq3b', 'uxyqmr', 'atwhdv', 'qypf66', 'ubbifw', 'ujahna', 'u8fgye', '6tuqy2', '5f2yfx', 'iynbwk']);

  // Track position to insert unified replacements
  let greekMathInserted = false;
  let greekTextInserted = false;
  let catMathInserted = false;
  let alignOpsInserted = false;
  let spacingOpsInserted = false;
  let subDoublesInserted = false;
  let pdMathInserted = false;
  let pdTextInserted = false;
  let ddMathInserted = false;
  let ddTextInserted = false;
  let integralsMathInserted = false;
  let integralsTextInserted = false;
  let bracketsMathInserted = false;
  let bracketsTextInserted = false;
  let fontManualInserted = false;
  let fontSymbolInserted = false;
  let fontCalScrInserted = false;
  let fontPostfixInserted = false;
  let postfixAccentsInserted = false;
  let dotsVariantsInserted = false;
  let unitVectorsInserted = false;
  let powersInserted = false;
  let inverseTrigTextInserted = false;
  let envGenericInserted = false;
  let matrixGridInserted = false;
  let scriptSubInserted = false;
  let scriptSuperInserted = false;
  let fractionManualInserted = false;
  let rootsManualInserted = false;
  let autoSubscriptTextInserted = false;

  const newSnippets: EusnipsSnippet[] = [];

  for (const s of result.snippets) {
    const pat = s.trigger.pattern;
    const ctx = s.context || 'any';

    // 1. Greek Math
    if (ctx === 'math' && greekMathTriggers.has(pat)) {
      if (!greekMathInserted) {
        newSnippets.push({
          id: 'greek_math',
          trigger: { pattern: '@(vth|vpi|vph|ve|vt|Th|pi|Pi|vr|vs|ta|Ph|ch|ps|Ps|th|[abgGdDeziklLmnxXrRsSuUphoO])' },
          description: 'Greek alphabet',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 1001,
          body: '\\``rv = GREEK[m[1]]`` '
        });
        greekMathInserted = true;
      }
      continue;
    }

    // 2. Greek Text
    if (ctx === 'text' && greekTextTriggers.has(pat)) {
      if (!greekTextInserted) {
        newSnippets.push({
          id: 'greek_text',
          trigger: { pattern: ' @(vth|vpi|vph|ve|vt|Th|pi|Pi|vr|vs|ta|Ph|ch|ps|Ps|th|[abgGdDeziklLmnxXrRsSuUphoO])' },
          description: 'Auto inline Greek alphabet',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          priority: 1000,
          body: ' \\$\\``rv = GREEK[m[1]]``\\$ '
        });

        greekTextInserted = true;
      }
      continue;
    }

    // 3. Category Theory Math
    if (ctx === 'math' && catMathTriggers.has(pat)) {
      if (!catMathInserted) {
        newSnippets.push({
          id: 'categories_math',
          trigger: { pattern: '(Set|Grp|Ab|Vect|Vec|Matr|Top|Toph|Ring|CRing|CAlg|Alg|Rng|Mod|SMod|Mon|CMon|Poset|Graph|CW|hCW|Diff|Man|Met|Hilb|Ban|Field|FinSet|Rel|Cat|CAT|Ord|Simp|Sp|Ens|Pos|PreO|Hask|Cob|FinS|FinV|Meas|Sch|Bimod|Haus|CompH|PL|Lat|B \\\\oo l|Heyt|Type|Asm|AffSch|Aff|Var|SmVar|AffVar|ProjVar)( |\\*)' },
          description: 'Category Theory font',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 700,
          body: '\\bf{``rv = (CAT_MAP[m[1]] || m[1]) + (m[2] === "*" ? "_*" : "")``}'
        });
        catMathInserted = true;
      }
      continue;
    }

    // 4. Alignment Operators
    if (alignOpTriggers.has(pat)) {
      if (!alignOpsInserted) {
        newSnippets.push({
          id: 'align_ops',
          trigger: { pattern: ';([=<>gln+\\-])' },
          description: 'Insert & <op> &',
          expand: 'auto',
          boundary: 'anywhere',
          priority: 10000,
          body: ' & ``rv = ALIGN_OPS[m[1]]`` & '
        });
        alignOpsInserted = true;
      }
      continue;
    }

    // 5. Operator Spacing
    if (ctx === 'math' && spacingOpTriggers.has(pat)) {
      if (!spacingOpsInserted) {
        newSnippets.push({
          id: 'spacing_ops',
          trigger: { pattern: '(.)([\\+\\-<=>~:])' },
          description: 'Operator spacing',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 100,
          body: '``rv = m[1] + (m[1] === " " ? "" : " ") + m[2] + " "``'
        });
        spacingOpsInserted = true;
      }
      continue;
    }

    // 6. Double Letter Subscripts
    if (ctx === 'math' && subDoubleTriggers.has(pat)) {
      if (!subDoublesInserted) {
        newSnippets.push({
          id: 'sub_doubles',
          trigger: { pattern: '(aa|ii|jj|kk|mm|nn|pp|qq|rr|ss|tt|uu|vv|xx|yy|zz)' },
          description: 'Subscript double letter',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 200,
          body: '_{``rv = m[1][0]``}'
        });
        subDoublesInserted = true;
      }
      continue;
    }

    // 7. Partial Derivatives (pd)
    if (ctx === 'math' && pdMathTriggers.has(pat)) {
      if (!pdMathInserted) {
        newSnippets.push({
          id: 'pd_math',
          trigger: { pattern: 'pd([123n])' },
          description: 'Partial derivative',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 200,
          body: '\\frac{\\bd``rv = m[1] === "1" ? "" : "^" + m[1]`` $1}{\\bd $2``rv = m[1] === "1" ? "" : "^" + m[1]``}$0'
        });
        pdMathInserted = true;
      }
      continue;
    }
    if (ctx === 'text' && pdTextTriggers.has(pat)) {
      if (!pdTextInserted) {
        newSnippets.push({
          id: 'pd_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s+)pd([123n]) ' },
          description: 'Partial derivative (text)',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          priority: 20000,
          body: '``rv = (m[1] ? "" : m[2] + "\\\\$") + "\\\\frac{\\\\bd" + (m[3] === "1" ? "" : "^" + m[3]) + " $1}{\\\\bd $2" + (m[3] === "1" ? "" : "^" + m[3]) + "}\\\\$"``$0'
        });
        pdTextInserted = true;
      }
      continue;
    }

    // 8. Ordinary Derivatives (dd)
    if (ctx === 'math' && ddMathTriggers.has(pat)) {
      if (!ddMathInserted) {
        newSnippets.push({
          id: 'dd_math',
          trigger: { pattern: 'dd([123n])' },
          description: 'Ordinary derivative',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 200,
          body: '\\frac{d``rv = m[1] === "1" ? "" : "^" + m[1]`` $1}{d $2``rv = m[1] === "1" ? "" : "^" + m[1]``}$0'
        });
        ddMathInserted = true;
      }
      continue;
    }
    if (ctx === 'text' && ddTextTriggers.has(pat)) {
      if (!ddTextInserted) {
        newSnippets.push({
          id: 'dd_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s+)dd([123n]) ' },
          description: 'Ordinary derivative (text)',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          priority: 20000,
          body: '``rv = (m[1] ? "" : m[2] + "\\\\$") + "\\\\frac{d" + (m[3] === "1" ? "" : "^" + m[3]) + " $1}{d $2" + (m[3] === "1" ? "" : "^" + m[3]) + "}\\\\$"``$0'
        });
        ddTextInserted = true;
      }
      continue;
    }

    // 9. Integrals
    if (ctx === 'math' && integralMathTriggers.has(pat)) {
      if (!integralsMathInserted) {
        newSnippets.push({
          id: 'integrals_math',
          trigger: { pattern: '([23o]?)int' },
          description: 'Integral',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 700,
          body: '\\``rv = m[1] === "2" ? "iint" : m[1] === "3" ? "iiint" : m[1] === "o" ? "oint" : "int"`` '
        });
        integralsMathInserted = true;
      }
      continue;
    }
    if (ctx === 'text' && integralTextTriggers.has(pat)) {
      if (!integralsTextInserted) {
        newSnippets.push({
          id: 'integrals_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s+)([23o]?)int ' },
          description: 'Integral (text)',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          priority: 200,
          body: '``rv = (m[1] ? "" : m[2] + "\\\\$") + "\\\\" + (m[3] === "2" ? "iint" : m[3] === "3" ? "iiint" : m[3] === "o" ? "oint" : "int") + " $1\\\\$ "``'
        });
        integralsTextInserted = true;
      }
      continue;
    }

    // 10. Brackets [anspbg]"
    if (ctx === 'math' && bracketMathTriggers.has(pat)) {
      if (!bracketsMathInserted) {
        newSnippets.push({
          id: 'brackets_math',
          trigger: { pattern: '([anspbg])"' },
          description: 'Bracket wrapper',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 100,
          body: '\\``rv = m[1]``{$1}'
        });
        bracketsMathInserted = true;
      }
      continue;
    }
    if (ctx === 'text' && bracketTextTriggers.has(pat)) {
      if (!bracketsTextInserted) {
        newSnippets.push({
          id: 'brackets_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s+)([anspbg])"' },
          description: 'Bracket wrapper (text)',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          priority: 100,
          body: '``rv = (m[1] ? "" : m[2] + "\\\\$") + "\\\\" + m[3] + "{$1}\\\\$ "``'
        });
        bracketsTextInserted = true;
      }
      continue;
    }

    // 11. Font Styles Math
    if (ctx === 'math' && fontManualTriggers.has(pat)) {
      if (!fontManualInserted) {
        newSnippets.push({
          id: 'font_manual',
          trigger: { pattern: '(?<![a-zA-Z])(bb|cal|scr|bf|bm|rm|sf|tt|frk|ds|bs) ' },
          description: 'font style (manual)',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          priority: 100,
          body: '\\``rv = m[1]``{$1}'
        });
        fontManualInserted = true;
      }
      continue;
    }
    if (ctx === 'math' && fontSymbolTriggers.has(pat)) {
      if (!fontSymbolInserted) {
        newSnippets.push({
          id: 'font_symbol',
          trigger: { pattern: '(bb|bf|bm|rm|sf|tt|frk|ds|bs)([0-9a-zA-Z])' },
          description: 'font style symbol',
          expand: 'auto',
          boundary: 'word',
          context: 'math',
          priority: 200,
          body: '\\``rv = m[1]``{``rv = m[2]``}'
        });
        fontSymbolInserted = true;
      }
      continue;
    }
    if (ctx === 'math' && fontCalScrTriggers.has(pat)) {
      if (!fontCalScrInserted) {
        newSnippets.push({
          id: 'font_cal_scr',
          trigger: { pattern: '(cal|scr)([A-Z])' },
          description: 'calligraphic/script symbol',
          expand: 'auto',
          boundary: 'word',
          context: 'math',
          priority: 200,
          body: '\\``rv = m[1]``{``rv = m[2]``}'
        });
        fontCalScrInserted = true;
      }
      continue;
    }
    if (ctx === 'math' && fontPostfixTriggers.has(pat)) {
      if (!fontPostfixInserted) {
        newSnippets.push({
          id: 'font_postfix',
          trigger: { pattern: '([a-zA-Z]+)(bb|cal|scr|bf|bm|rm|sf|frk|ds|bs)' },
          description: 'postfix font style',
          expand: 'auto',
          boundary: 'word',
          context: 'math',
          priority: 200,
          body: '\\``rv = m[2]``{``rv = m[1]``}'
        });
        fontPostfixInserted = true;
      }
      continue;
    }

    // 12. Postfix Accents / Diacritics
    if (ctx === 'math' && (
      s.id === 'postfix_accents_math' ||
      ((pat.endsWith('bar') || pat.endsWith('bre') || pat.endsWith('what') || pat.endsWith('hat') ||
        pat.endsWith('wtil') || pat.endsWith('til') || pat.endsWith('wvec') || pat.endsWith('vec') ||
        pat.endsWith('dot') || pat.endsWith('conj') || pat.endsWith('trans')) &&
       !pat.endsWith('rvec') && !pat.endsWith('cvec'))
    )) {
      if (!postfixAccentsInserted) {
        newSnippets.push({
          id: 'postfix_accents_math',
          trigger: {
            pattern: '(\\\\?(?:[a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+|\\\\b(?:mu |alpha |sigma |rho |beta |gamma |delta |zeta |eta |varepsilon |theta |iota |kappa |vartheta |lambda |nu |pi |tau |upsilon |phi |chi |psi |omega |Gamma |Delta |Theta |Lambda |Xi |Pi |Sigma |Upsilon |Phi |Psi |Omega )\\\\b)(?:[\\^_\x27{}]|[0-9a-zA-Z])*?)(bar|bre|what|(?<!w)hat|wtil|(?<!w)til|wvec|(?<!w)vec|dot|conj|trans)'
          },
          description: 'postfix accents and diacritics',
          priority: 200,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          body: '\\``rv = ACCENT_MAP[m[2]] || m[2]``{``rv = m[1]``}'
        });
        postfixAccentsInserted = true;
      }
      continue;
    }

    // 13. Dots Variants
    if (ctx === 'math' && (
      s.id === 'dots_variants' ||
      ['..c', '..m', '..b', '..i', '..o', '\\.\\.c', '\\.\\.m', '\\.\\.b', '\\.\\.i', '\\.\\.o'].includes(pat) ||
      ['k79n9s', '5u3ff4', 'u4s99v', 'netu3m', '5jf47j'].includes(s.id ?? "")
    )) {
      if (!dotsVariantsInserted) {
        newSnippets.push({
          id: 'dots_variants',
          trigger: { pattern: '\\.\\.([cmbio])' },
          description: 'dots variants',
          priority: 300,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          body: '\\dots``rv = m[1]``'
        });
        dotsVariantsInserted = true;
      }
      continue;
    }

    // 14. Unit Vectors
    if (ctx === 'math' && (
      s.id === 'unit_vectors_math' ||
      [':x', ':y', ':z'].includes(pat) ||
      ['wasbvz', 'u8x8g6', '7vgyhm'].includes(s.id ?? "")
    )) {
      if (!unitVectorsInserted) {
        newSnippets.push({
          id: 'unit_vectors_math',
          trigger: { pattern: ':(x|y|z)' },
          description: 'unit vectors',
          priority: 100,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          body: '\\hat{\\bf{``rv = m[1]``}}'
        });
        unitVectorsInserted = true;
      }
      continue;
    }

    // 15. Powers
    if (ctx === 'math' && (
      s.id === 'powers_math' ||
      pat.endsWith('sq ') || pat.endsWith('cub') || /p[0-9]$/.test(pat)
    )) {
      if (!powersInserted) {
        newSnippets.push({
          id: 'powers_math',
          trigger: {
            pattern: '(\\\\?(?:[0-9a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+|\\\\b(?:mu |alpha |sigma |rho |beta |gamma |delta |zeta |eta |varepsilon |theta |iota |kappa |vartheta |lambda |nu |pi |tau |upsilon |phi |chi |psi |omega |Gamma |Delta |Theta |Lambda |Xi |Pi |Sigma |Upsilon |Phi |Psi |Omega )\\\\b)(?:[\\^_\x27{}]|[0-9a-zA-Z])*?)(sq |cub|p[0-9])'
          },
          description: 'powers shortcut',
          priority: 200,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          body: '``rv = m[1]``^{``rv = m[2] === "sq " ? "2" : m[2] === "cub" ? "3" : m[2][1]``}'
        });
        powersInserted = true;
      }
      continue;
    }

    // 16. Text Inverse Trig
    if (ctx === 'text' && (
      s.id === 'inverse_trig_text' ||
      /(sin|cos|tan|cot|sec|csc)iv $/.test(pat) ||
      ['iaewm2', '3fcgtk', 'bzavyp'].includes(s.id ?? "")
    )) {
      if (!inverseTrigTextInserted) {
        newSnippets.push({
          id: 'inverse_trig_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*,|\\s+)(sin|cos|tan|cot|sec|csc)iv ' },
          description: 'inverse trig (text)',
          priority: 200,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          body: '``rv = openInlineMathDelimited(m, 2, 1) + "\\\\" + m[3] + "^{-1}{($1)}\\\\$ ";``'
        });
        inverseTrigTextInserted = true;
      }
      continue;
    }

    // 17. Generic Environments
    if (s.id === 'environments_generic' || (pat.startsWith('(\\s*)') && /(?:aln|gth|eqt|mtl|thrm|crl|lmm|exmp|rmk|dfn|prf|fgr|arr|tikz|vbt|abtr)$/.test(pat))) {
      if (!envGenericInserted) {
        newSnippets.push({
          id: 'environments_generic',
          trigger: { pattern: '(\\s*)(s)?(aln|gth|eqt|mtl|thrm|crl|lmm|exmp|rmk|dfn|prf|fgr|arr|tikz|vbt|abtr)' },
          description: 'LaTeX environment block',
          priority: 100,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'any',
          body: '\\begin{``rv = ENV_MAP[m[3]] + (m[2] ? "*" : "")``}\n\t$1\n\\end{``rv = ENV_MAP[m[3]] + (m[2] ? "*" : "")``}$0'
        });
        envGenericInserted = true;
      }
      continue;
    }

    // 18. Matrix Grid Generator
    if (s.id === 'matrix_grid_gen' || pat.includes('mat_{')) {
      if (!matrixGridInserted) {
        newSnippets.push({
          id: 'matrix_grid_gen',
          trigger: { pattern: '(\\s*)(p|b|v|V|small)?mat_{([1-9])}( )?([1-9])' },
          description: 'Matrix grid generator',
          priority: 200,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          body: '``rv = buildMatrixGrid(m);``'
        });
        matrixGridInserted = true;
      }
      continue;
    }

    // 19. Subscripts & Superscripts (ud / ov)
    if (s.id === 'script_sub_math_text' || s.id === 'script_super_math_text' || (
      (pat.includes('ud') || pat.includes('ov')) &&
      !pat.includes('udl') && !pat.includes('ovl') && !pat.includes('udb') && !pat.includes('ovb') && !pat.includes('ovl|')
    )) {
      if (!scriptSubInserted) {
        newSnippets.push({
          id: 'script_sub_math_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*|\\b)(?:([a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+)ud|ud)([0-9a-zA-Z]*)' },
          description: 'Subscript shortcut (math & text)',
          priority: 150,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'any',
          body: '``rv = formatScript(m, "sub");``'
        });
        scriptSubInserted = true;
      }
      if (!scriptSuperInserted) {
        newSnippets.push({
          id: 'script_super_math_text',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*|\\b)(?:([a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+)ov|ov)([0-9a-zA-Z]*)' },
          description: 'Superscript shortcut (math & text)',
          priority: 150,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'any',
          body: '``rv = formatScript(m, "super");``'
        });
        scriptSuperInserted = true;
      }
      continue;
    }

    // 20. Manual Fractions & Roots
    if (s.id === 'fractions_manual' || (pat.endsWith('//') || pat.includes('frac')) && !pat.includes('renderFunction')) {
      if (!fractionManualInserted) {
        newSnippets.push({
          id: 'fractions_manual',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*,|\\s+)?(//|frac )' },
          description: 'Fraction shortcut',
          priority: 150,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'any',
          body: '``rv = formatFraction(m);``'
        });
        fractionManualInserted = true;
      }
      continue;
    }

    if (s.id === 'roots_manual_auto' || (pat.includes('sqr') && !pat.includes('renderFunction'))) {
      if (!rootsManualInserted) {
        newSnippets.push({
          id: 'roots_manual_auto',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*,|\\s+)?sqr(?:([0-9a-zA-Z\']+)(?:_([0-9]))?| )' },
          description: 'Square root shortcut',
          priority: 150,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'any',
          body: '``rv = formatSqrt(m);``'
        });
        rootsManualInserted = true;
      }
      continue;
    }

    // 21. Text Auto Subscripts & Indices
    if (s.id === 'auto_subscript_text_digits_indices' || (ctx === 'text' && (pat.includes('((?:i|j|k|r|s)') || pat.includes('ud([0-9') || pat.includes('ov([0-9')))) {
      if (!autoSubscriptTextInserted) {
        newSnippets.push({
          id: 'auto_subscript_text_digits_indices',
          trigger: { pattern: '(\\$)?(?<!\\.)(\\s*,|\\s+)(?:(ds|sf|rm|bf|bb|bs|bm|cal|scr|frk)|\\\\)?([A-Za-zα-ωϵϕΦΠΣΘΩΨℏ]+|\\\\b(?:mu|alpha|sigma|rho|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)\\b)(?:\'*|\’)?(?:(ud|ov)([0-9a-zA-Z]*)|((?:i|j|k|r|s),?(?:i|j|k|r|s)|[0-9]))([\\s\\-.,;])' },
          description: 'Auto subscript digits and double indices (text)',
          priority: 1000,
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          body: '``let base = (m[3] ? "\\\\" + m[3] + "{" + m[4] + "}" : m[4]); let op = m[5] === "ov" ? "^" : "_"; let sub = m[6] !== undefined ? m[6] : m[7]; rv = (m[1] ? "" : m[2] + "\\\\$") + base + op + "{" + sub + "}\\\\$\" + (m[8] || "");``'
        });
        autoSubscriptTextInserted = true;
      }
      continue;
    }

    // 12. Simplify Environment bodies with displayMathPrefix
    if (typeof s.body === 'string' && s.body.includes("if (typeof m !== 'undefined' && m[2] !== '')")) {
      const simplifiedBody = s.body.replace(
        /``if \(typeof m !== 'undefined' && m\[2\] !== ''\) \{[\s\S]*?\};?``/g,
        '``rv = displayMathPrefix(m);``'
      );
      newSnippets.push({
        ...s,
        body: simplifiedBody
      });
      continue;
    }

    // Default: keep snippet as is
    newSnippets.push(s);
  }

  // 12. Auto-inline math deduplication:
  // Identify comma-variant snippets and merge with their space-variant counterpart!
  const finalSnippets: EusnipsSnippet[] = [];
  const spaceVariantMap = new Map<string, number>(); // patternSuffix -> index in finalSnippets

  for (let i = 0; i < newSnippets.length; i++) {
    const s = newSnippets[i];
    const pat = s.trigger.pattern;
    const bodyStr = typeof s.body === 'string' ? s.body : '';

    // Check if this is a space-variant auto snippet: `(\$)?(?<!\.)(\s+)`
    if (pat.startsWith('(\\$)?(?<!\\.)(\\s+)')) {
      const suffix = pat.slice('(\\$)?(?<!\\.)(\\s+)'.length);
      const unifiedPattern = `(\\$)?(?<!\\.)(\\s*,|\\s+)${suffix}`;
      
      // Update body if it has the standard math-opening check
      let unifiedBody = bodyStr;
      if (unifiedBody.includes('if (m[1]) {\n    rv = m[3];\n} else {\n    rv = m[2] + "\\$" + m[3];\n}')) {
        unifiedBody = unifiedBody.replace(
          'if (m[1]) {\n    rv = m[3];\n} else {\n    rv = m[2] + "\\$" + m[3];\n}',
          'rv = openInlineMathDelimited(m, 2, 1) + m[3];'
        );
      } else if (unifiedBody.includes('if (m[1]) {\n    rv = "";\n} else {\n    rv = m[2] + "\\$" + "";\n}')) {
        unifiedBody = unifiedBody.replace(
          'if (m[1]) {\n    rv = "";\n} else {\n    rv = m[2] + "\\$" + "";\n}',
          'rv = openInlineMathDelimited(m, 2, 1);'
        );
      }

      // Check if it is a binary auto expression
      if (unifiedBody.includes('hold1 = "";\nif (m[3]) {')) {
        if (pat.includes('(\\+|\\-|\\=|\\>|\\<)') && pat.includes('(sin|cos|arccot|')) {
          unifiedBody = '``rv = renderFunctionBinary(m, "symbol");``';
        } else if (pat.includes('(\\+|\\-|\\=|\\>|\\<)')) {
          unifiedBody = '``rv = renderBinaryAuto(m, "symbol");``';
        } else if (pat.includes('(/)')) {
          unifiedBody = '``rv = renderBinaryAuto(m, "raw");``';
        } else if (pat.includes('(sin|cos|arccot|') && (pat.endsWith('(\\s|\\()') || pat.includes('(\\s|\\()'))) {
          unifiedBody = '``rv = renderFunctionTabstopBinary(m, "command");``';
        } else if (pat.includes('(sin|cos|arccot|')) {
          unifiedBody = '``rv = renderFunctionBinary(m, "command");``';
        } else {
          unifiedBody = '``rv = renderBinaryAuto(m);``';
        }
      }

      const mergedSnippet: EusnipsSnippet = {
        ...s,
        trigger: { ...s.trigger, pattern: unifiedPattern },
        body: unifiedBody
      };
      
      const newIdx = finalSnippets.length;
      finalSnippets.push(mergedSnippet);
      spaceVariantMap.set(suffix, newIdx);
      continue;
    }

    // Check if this is a comma-variant auto snippet: `(\$)?(?<!\.)(\s*),`
    if (pat.startsWith('(\\$)?(?<!\\.)(\\s*),')) {
      const suffix = pat.slice('(\\$)?(?<!\\.)(\\s*),'.length);
      if (spaceVariantMap.has(suffix)) {
        // Already merged into the unified pattern! Ensure unified snippet has highest priority
        const spaceIdx = spaceVariantMap.get(suffix)!;
        const spaceSnippet = finalSnippets[spaceIdx];
        if (s.priority && (!spaceSnippet.priority || s.priority > spaceSnippet.priority)) {
          spaceSnippet.priority = s.priority;
        }
        continue;
      }
    }

    finalSnippets.push(s);
  }

  console.log(`newSnippets.length: ${newSnippets.length}, finalSnippets.length: ${finalSnippets.length}`);
  result.snippets = finalSnippets;
  return result;
}

describe('Merge & Simplify Snippets in D:/XPlace/snippets.json', () => {
  it('merges snippet families, validates schema, and verifies engine loading', () => {
    const hsnipsPath = 'C:/Users/Yinji/AppData/Roaming/Code/User/hsnips/latex.hsnips';
    const userSnippetsPath = 'C:/Users/Yinji/AppData/Roaming/Eukolia/User/snippets/snippets.json';
    const hsnipsContent = fs.readFileSync(hsnipsPath, 'utf8');
    const userSnippets: EusnipsFile = JSON.parse(fs.readFileSync(userSnippetsPath, 'utf8'));

    const originalFile = translateHsnips(hsnipsContent, userSnippets);
    console.log(`Original snippet count: ${originalFile.snippets.length}`);
    expect(originalFile.snippets.length).toBe(883);

    const merged = mergeAndSimplifySnippets(originalFile);
    console.log(`Merged snippet count: ${merged.snippets.length}`);
    console.log(`Snippet reduction: ${originalFile.snippets.length - merged.snippets.length} snippets eliminated`);

    // Verify significant reduction
    expect(merged.snippets.length).toBeLessThan(700);

    // Schema Validation
    const validation = validateSnippetFile(merged);
    console.log('Schema valid:', validation.valid, 'Issues count:', validation.issues.length);
    if (!validation.valid) {
      console.error('Validation issues:', validation.issues);
    }
    expect(validation.valid).toBe(true);
    expect(validation.issues.length).toBe(0);

    // Engine Normalization & Loading
    const normalized = normalizeSnippetFile(merged);
    const errors = normalized.issues.filter(i => i.level === 'error');
    if (errors.length > 0) {
      console.error('Normalization errors:', errors);
    }
    expect(errors.length).toBe(0);

    const engine = new SnippetEngine();
    const loaded = loadEusnipsIntoEngine(engine, [normalized]);
    console.log(`Engine loaded count: ${loaded.length}, getSnippets count: ${engine.getSnippets('latex').length}`);
    expect(engine.getSnippets('latex').length).toBe(merged.snippets.length);
    expect(loaded.length).toBe(merged.snippets.length);

    // Functional expansion helper
    function expandText(text: string) {
      const completions = engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
      if (completions.length === 0) return null;
      // Sort by priority descending
      completions.sort((a, b) => b.snippet.priority - a.snippet.priority);
      return engine.expand(completions[0], { text, pushToStack: false }).plainText;
    }

    // 1. Greek Math: inside math mode ($...)
    expect(expandText('$@a')).toBe('\\alpha ');
    expect(expandText('$@th')).toBe('\\theta ');
    expect(expandText('$@ve')).toBe('\\varepsilon ');
    expect(expandText('$@G')).toBe('\\Gamma ');

    // 2. Greek Text: inside text mode
    expect(expandText(' @a')).toBe(' $\\alpha$ ');
    expect(expandText(' @th')).toBe(' $\\theta$ ');

    // 3. Category Math: inside math mode
    expect(expandText('$Set ')).toBe('\\bf{Set}');
    expect(expandText('$Set*')).toBe('\\bf{Set_*}');
    expect(expandText('$PreO ')).toBe('\\bf{PreOrd}');
    expect(expandText('$Diff ')).toBe('\\bf{Diff}');
    expect(expandText('$Matr ')).toBe('\\bf{Matr}');
    expect(expandText('$CRing ')).toBe('\\bf{CRing}');

    // 4. Alignment Delimiters
    expect(expandText(';=')).toBe(' & = & ');
    expect(expandText(';g')).toBe(' & \\geq & ');
    expect(expandText(';+')).toBe(' & + & ');

    // 5. Operator Spacing
    expect(expandText('$x+')).toBe('x + ');
    expect(expandText('$ +')).toBe(' + ');

    // 6. Subscript Double Letters
    expect(expandText('$aa')).toBe('_{a}');
    expect(expandText('$ii')).toBe('_{i}');
    expect(expandText('$xx')).toBe('_{x}');
    expect(expandText('$zz')).toBe('_{z}');

    // 7. Derivatives
    expect(expandText('$pd1')).toBe('\\frac{\\bd }{\\bd }');
    expect(expandText('$pd2')).toBe('\\frac{\\bd^2 }{\\bd ^2}');
    expect(expandText('$dd1')).toBe('\\frac{d }{d }');

    // 8. Integrals
    expect(expandText('$int')).toBe('\\int ');
    expect(expandText('$2int')).toBe('\\iint ');
    expect(expandText('$oint')).toBe('\\oint ');
    expect(expandText(' 2int ')).toBe(' $\\iint $ ');

    // 9. Brackets
    expect(expandText('$a"')).toBe('\\a{}');
    expect(expandText('$p"')).toBe('\\p{}');

    // 10. Binary & Operator Expressions without spurious backslashes
    // Arithmetic & Relational (qkngfs): NO backslash
    expect(expandText(' a+b ')).toBe(' $a + b$ ');
    expect(expandText(' a=b ')).toBe(' $a = b$ ');
    expect(expandText(' a-b ')).toBe(' $a - b$ ');
    expect(expandText(' a>b ')).toBe(' $a > b$ ');
    expect(expandText(' a<b ')).toBe(' $a < b$ ');

    // Division (k6i5w8): NO backslash and tight spacing
    expect(expandText(' a/b ')).toBe(' $a/b$ ');

    // Symbol op + Function (5mt7v5): NO backslash on +, YES on function
    expect(expandText(' a+sinb ')).toBe(' $a + \\sin(b)$ ');

    // Command op + Function (wa5rsg)
    expect(expandText(' aperpcosb ')).toBe(' $a \\perp \\cos(b)$ ');

    // Command op + Function Tabstop (69bz6e)
    expect(expandText(' aperpsin ')).toBe(' $a \\perp \\sin $ ');
    expect(expandText(' aperpsin(')).toBe(' $a \\perp \\sin()$ ');

    // Greek Atom Binary (amez7j): Greek gets backslash
    expect(expandText(' alphaperpb ')).toBe(' $\\alpha \\perp b$ ');

    // 11. Font Expansions
    expect(expandText('$bb ')).toBe('\\bb{}');
    expect(expandText('$cal ')).toBe('\\cal{}');
    expect(expandText('$bbA')).toBe('\\bb{A}');
    expect(expandText('$calA')).toBe('\\cal{A}');
    expect(expandText('$cala')).toBeNull();
    expect(expandText('$Xbb')).toBe('\\bb{X}');
    expect(expandText('$Homocal')).toBe('\\cal{Homo}');
    expect(expandText(' bbA ')).toBeNull();

    // 12. Write and verify final merged file at D:\XPlace\snippets.json and User snippets
    const targetPath = 'D:/XPlace/snippets.json';
    const userPath = 'C:/Users/Yinji/AppData/Roaming/Eukolia/User/snippets/snippets.json';
    const mergedJson = JSON.stringify(merged, null, 2);
    fs.writeFileSync(targetPath, mergedJson, 'utf8');
    if (fs.existsSync(userPath)) {
      fs.writeFileSync(userPath, mergedJson, 'utf8');
    }

    // Verify written file
    const readBack = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    const reValidation = validateSnippetFile(readBack);
    expect(reValidation.valid).toBe(true);
    expect(reValidation.issues.length).toBe(0);
    expect(readBack.snippets.length).toBe(556);

    const stats = fs.statSync(targetPath);
    console.log(`Verified merged snippets at ${targetPath}: ${stats.size} bytes, ${readBack.snippets.length} snippets.`);
  });
});
