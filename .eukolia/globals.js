const greek = {}

function gen_matrix(nrow, ncol, indent) {
  let results = "\n" + indent;
  let order = 1;
  for (var i = 0; i < nrow; i++) {
    results += ' ';
    for (var j = 0; j < ncol - 1; j++) {
      results += "$" + (order).toString() + " & ";
      order++;
    }
    results += "$" + (order).toString() + " \\\\" + "\\" + "\n" + indent;
    order++;
  }
  return results;
}

function gen_matrix_transposed(nrow, ncol) {
  let results = "\n";
  for (var i = 0; i < nrow; i++) {
    results += ' ';
    var j = 0;
    for (; j < ncol - 1; j++) {
      results += "$" + (i + j * ncol + 1).toString() + " & ";
    }
    results += "$" + (i + j * ncol + 1).toString() + " \\\\" + "\\" + "\n";
  }
  return results;
}

function tes_matrix(nrow, ncol, t) {
  let results = "\n";
  let order = 1;
  for (var i = 0; i < nrow; i++) {
    results += '	';
    for (var j = 0; j < ncol - 1; j++) {
      if (order > 1) {
        results += "${" + (order).toString() + ":" + t[order - 2] + "}\t & ";
      }
      else {
        results += "$" + (order).toString() + " & ";
      }
      order++;
    }
    results += "$" + (order).toString() + " \\\\" + "\\ ";
    order++;
  }
  return results;
}

// 输出一个表格
function createTable(nrows, ncols, indent) {
  nrows = parseInt(nrows);
  ncols = parseInt(ncols);

  if (nrows === 0 | ncols === 0) {
    return "";
  }

  ret = "\\begin{tabular}";

  if (ncols > 1) {
    ret += "{ |c|" + "c|".repeat(ncols - 2) + "c| }";
  } else {
    ret += "{ |c| }";
  }

  ret += "\n";

  let order = 1;

  for (let i = 0; i < nrows; i++) {
    ret += indent + "\\hline\n" + indent;
    for (let j = 0; j < ncols; j++) {
      if (j != ncols - 1) {
        ret += "$" + (order).toString() + " " + "&";
      } else {
        ret += "$" + (order).toString() + " " + "\\\\" + "\\";
        ret += "\n";
      }
      order++;
    }
  }
  ret += indent + "\\hline\n";

  ret += indent + "\\end{tabular}\n";

  return ret;
}

function createTableNoLine(nrows, ncols) {
  nrows = parseInt(nrows);
  ncols = parseInt(ncols);

  if (nrows === 0 | ncols === 0) {
    return "";
  }

  ret = "\\begin{tabular}";

  if (ncols > 1) {
    ret += "{ |c|" + "c|".repeat(ncols - 2) + "c| }";
  } else {
    ret += "{ |c| }";
  }

  ret += "\n\\hline\n";

  let order = 1;

  for (let i = 0; i < nrows; i++) {
    for (let j = 0; j < ncols; j++) {
      if (j != ncols - 1) {
        ret += "$" + (order).toString() + " " + "&";
      } else {
        ret += "$" + (order).toString() + " " + "\\\\" + "\\";
        ret += "\n";
      }
      order++;
    }
  }
  ret += "\\hline\n";

  ret += "\\end{tabular}\n";

  return ret;
}
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

var ALIGN_OPS = {
  '=': '=',
  '<': '<',
  '>': '>',
  'g': '\\geq',
  'l': '\\leq',
  'n': '\\neq',
  '+': '+',
  '-': '-'
};

var CAT_MAP = {
  PreO: 'PreOrd',
  FinS: 'FinSet',
  FinV: 'FinVect',
  CompH: 'CompHaus',
  'B \\oo l': 'Bool'
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
  return match[1] ? content : match[2] + "\\$" + content;
}

function displayMathPrefix(match) {
  if (match && typeof match[2] !== "undefined" && match[2] !== "") {
    const math = match[2].replace(/\$/g, "\\$");
    return match[1] + math + "\n" + match[1];
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
  const opening = match[dollarIndex] ? "" : delimiter.whitespace + "\\$";
  return opening + delimiter.comma;
}

const GREEK_REGEX = /^(?:mu|alpha|sigma|rho|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)('*)?$/;

const ATOM_MAP = {
  sim: '\\sim',
  '~': '\\sim'
};

function renderDecoratedAtom(style, atom, accent, prefix = "") {
  let value = prefix;
  const isGreek = atom && GREEK_REGEX.test(atom);
  let atomText = isGreek ? "\\" + atom : (ATOM_MAP[atom] || atom || "");
  value += style ? "\\" + style + "{" + atomText + "}" : atomText;
  return accent ? "\\" + accent + "{" + value + "}" : value;
}

function renderBinaryAuto(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  if (mode === "command") {
    out += " \\" + op + " ";
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
  let out = match[1] ? delimiter.whitespace : " " + "\\$";
  out += renderDecoratedAtom(match[3], match[4], null, delimiter.comma);
  out += " \\" + (match[6] || "") + " ";
  out += renderDecoratedAtom(match[7], match[8], null);
  return out + "$" + (match[10] || "");
}

function renderFunctionBinary(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  out += mode === "command" ? " \\" + op + " " : " " + op + " ";
  out += "\\" + (match[8] || "") + "(";
  out += renderDecoratedAtom(match[9], match[10], match[12]);
  return out + ")$" + (match[13] || "");
}

function renderFunctionTabstopBinary(match, mode = "command") {
  const delimiter = splitInlineDelimiter(match[2] || "");
  let out = match[1] ? delimiter.whitespace : " " + "\\$";
  out += renderDecoratedAtom(match[3], match[4], match[6], delimiter.comma);

  const op = match[7] || "";
  out += mode === "command" ? " \\" + op + " " : " " + op + " ";

  const fn = match[8] || "";
  const sep = match[9] || "";
  if (sep === " ") {
    return out + "\\" + fn + " $1$ ";
  } else {
    return out + "\\" + fn + "($1)$ ";
  }
}

function renderTernaryEquation(match, tightOp = false) {
  let out = match[1] ? (match[2] || "") : " \\$";
  let left = renderDecoratedAtom(match[3], match[4], match[6]);
  let mid = renderDecoratedAtom(match[7], match[8], match[10]);
  let right = renderDecoratedAtom(match[12], match[13], match[15]);
  let op = match[11] || "";
  let opStr = tightOp ? op : " " + op + " ";
  return out + left + " = " + mid + opStr + right + "$" + (match[16] || "");
}

function renderSubscriptedOperator(match, hasLeadingComma = false) {
  let out = match[1] ? (match[2] || "") : " \\$";
  const prefix = hasLeadingComma ? "," : "";
  if (match[3]) {
    out += prefix + "\\" + match[3] + "{" + (match[4] || "") + "}";
  } else {
    out += prefix + (match[4] || "");
  }
  if (match[6]) out += "_{" + match[6] + "}";
  out += " \\" + (match[7] || "") + " ";
  if (match[8]) {
    out += "\\" + match[8] + "{" + (match[9] || "") + "}";
  } else {
    out += match[9] || "";
  }
  if (match[11]) out += "_{" + match[11] + "}";
  return out + "$" + (match[12] || "");
}

function renderMultiIntegral(match) {
  let isO = match[1] === "o";
  let isL = match[2] === "l";
  let b = (match[3] === 'd') ? 2 : (match[3] === 't') ? 3 : 1;
  let final = "\\" + (isO ? "o" : "") + "i".repeat(b - 1) + "int";
  if ((b >= 2) || (b !== 1 && !isO && isL)) final += "\\limits";
  let r = (b === 3) ? "E" : (b === 1 && (isL || isO)) ? "C" : "R";
  final += ((b >= 2) || isO || (b === 1 && isL)) ? "_{${1:" + r + "}}" : "_{${1:-\\oo}}^{${2:\\oo}}";
  let x = (b === 2) ? "A" : (b === 3) ? "V" : (b === 1 && isL) ? "s" : "x";
  final += " ${3} \\mathrm{d}${4:" + x + "}$0";
  return final;
}


function renderMinorScript(match) {
  let atom = match[4] || "";
  if (atom.startsWith("@")) {
    const alias = atom.slice(1);
    const greekName =
      (typeof FIBERED_GREEK_ALIASES !== "undefined" && FIBERED_GREEK_ALIASES[alias]) ||
      (typeof GREEK !== "undefined" && GREEK[alias]);
    atom = greekName ? (greekName.startsWith("\\") ? greekName : "\\" + greekName) : atom;
  }

  const open = openInlineMathDelimited(match, 2, 1);
  const base = renderDecoratedAtom(match[3], atom, match[5]);
  const scriptOp = match[7] === "*" ? "*" : "\\" + match[7];
  const script = (match[6] === "ov" ? "^" : "_") + "{" + scriptOp + "}";

  return open + base + script + "\\$" + (match[8] || "") + "$0";
}

// Truncated power series compute Taylor coefficients without subtracting
// nearly equal function values. Order n keeps powers 0,...,n-1.
function gen_taylor_approx(m) {
  const unchanged = () => String(m[0] || '') + '$0';
  let source = (m[2] || '').trim(), center = (m[3] || '').trim();
  if (!center && source.includes(',')) {
    const comma = source.lastIndexOf(',');
    center = source.slice(comma + 1).trim();
    source = source.slice(0, comma).trim();
  }
  center = center || '0';
  const n = m[1] ? Number(m[1]) : 4;
  if (!Number.isInteger(n) || n < 1 || n > 32) return unchanged();
  const constant = value => [value, ...Array(n - 1).fill(0)];
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (a, v) => a.map(x => x * v);
  const mul = (a, b) => a.map((_, k) => {
    let value = 0;
    for (let j = 0; j <= k; j++) value += a[j] * b[k - j];
    return value;
  });
  function div(a, b) {
    if (b[0] === 0) throw new Error('Singular Taylor expansion');
    const out = constant(0);
    for (let k = 0; k < n; k++) {
      let value = a[k];
      for (let j = 1; j <= k; j++) value -= b[j] * out[k - j];
      out[k] = value / b[0];
    }
    return out;
  }
  const derivative = a => a.map((_, k) => (k + 1) * (a[k + 1] || 0));
  const integral = (a, value) => a.map((_, k) => k ? a[k - 1] / k : value);
  function exp(a) {
    const out = constant(Math.exp(a[0]));
    for (let k = 1; k < n; k++) {
      for (let j = 1; j <= k; j++) out[k] += j * a[j] * out[k - j] / k;
    }
    return out;
  }
  function log(a) {
    if (a[0] <= 0) throw new Error('Non-real logarithm');
    return integral(div(derivative(a), a), Math.log(a[0]));
  }
  function power(a, b) {
    if (b.slice(1).every(v => v === 0) && Number.isSafeInteger(b[0])) {
      let k = Math.abs(b[0]), out = constant(1), factor = a;
      while (k) {
        if (k % 2) out = mul(out, factor);
        k = Math.floor(k / 2);
        if (k) factor = mul(factor, factor);
      }
      return b[0] < 0 ? div(constant(1), out) : out;
    }
    return exp(mul(b, log(a)));
  }
  function sincos(a) {
    const sin = constant(Math.sin(a[0])), cos = constant(Math.cos(a[0]));
    for (let k = 1; k < n; k++) {
      for (let j = 1; j <= k; j++) {
        sin[k] += j * a[j] * cos[k - j] / k;
        cos[k] -= j * a[j] * sin[k - j] / k;
      }
    }
    return [sin, cos];
  }
  function call(name, a) {
    if (name === 'exp') return exp(a);
    if (name === 'ln' || name === 'log') return log(a);
    if (name === 'sqrt') return power(a, constant(0.5));
    if (name === 'abs') {
      if (a[0] === 0 && a.slice(1).some(v => v !== 0)) throw new Error('Nonanalytic absolute value');
      return scale(a, a[0] < 0 ? -1 : 1);
    }
    if (/^(sin|cos|tan|sec|csc|cot)$/.test(name)) {
      const [s, c] = sincos(a);
      return {
        sin: () => s, cos: () => c, tan: () => div(s, c),
        sec: () => div(constant(1), c), csc: () => div(constant(1), s), cot: () => div(c, s)
      }[name]();
    }
    if (/^(a|arc)(sin|cos|tan)$/.test(name)) {
      const kind = name.slice(-3), square = mul(a, a);
      const denominator = kind === 'tan' ? add(constant(1), square)
        : power(add(constant(1), scale(square, -1)), constant(0.5));
      const slope = scale(div(derivative(a), denominator), kind === 'cos' ? -1 : 1);
      return integral(slope, Math['a' + kind](a[0]));
    }
    throw new Error('Unsupported function');
  }
  function evaluate(raw, x, variable = null) {
    let text = String(raw)
      .replace(/\\(?:left|right)\b/g, '')
      .replace(/\\(?:d?frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
      .replace(/\\([A-Za-z]+)/g, '$1')
      .replace(/\{/g, '(').replace(/\}/g, ')');
    text = text.replace(/\b(sin|cos|tan|sec|csc|cot)\s*\^\s*\(?(-?\d+)\)?\s*\(([^()]*)\)/g, '($1($3))^$2');
    text = text.replace(/\b(sin|cos|tan|sec|csc|cot)\s*\^\s*\(?(-?\d+)\)?\s*([A-Za-z])\b/g, '($1($3))^$2');
    text = text.replace(/\b(sin|cos|tan|sec|csc|cot|exp|ln|log|sqrt|abs|asin|acos|atan|arcsin|arccos|arctan)\s*([A-Za-z])\b/g, '$1($2)');
    const tokens = text.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[^\s]/g) || [];
    let pos = 0;
    const peek = () => tokens[pos];
    function expression() {
      let a = term();
      while (peek() === '+' || peek() === '-') {
        const op = tokens[pos++], b = term();
        a = add(a, scale(b, op === '-' ? -1 : 1));
      }
      return a;
    }
    function term() {
      let a = unary();
      while (pos < tokens.length) {
        const op = peek();
        if (op === '*' || op === '/') {
          pos++;
          a = op === '*' ? mul(a, unary()) : div(a, unary());
        } else if (op === '(' || /^[A-Za-z0-9.]/.test(op)) a = mul(a, unary());
        else break;
      }
      return a;
    }
    function unary() {
      if (peek() === '+' || peek() === '-') {
        const sign = tokens[pos++];
        return scale(unary(), sign === '-' ? -1 : 1);
      }
      let a = primary();
      if (peek() === '^') { pos++; a = power(a, unary()); }
      return a;
    }
    function primary() {
      const token = tokens[pos++];
      if (token === undefined) throw new Error('Missing operand');
      if (/^(?:\d|\.\d)/.test(token)) return constant(Number(token));
      if (token === variable) { if (!x) throw new Error('Variable center'); return x; }
      if (token === 'pi') return constant(Math.PI);
      if (token === 'e') return constant(Math.E);
      if (token === '(') {
        const a = expression();
        if (tokens[pos++] !== ')') throw new Error('Unbalanced group');
        return a;
      }
      if (/^[A-Za-z]+$/.test(token) && peek() === '(') {
        pos++;
        const a = expression();
        if (tokens[pos++] !== ')') throw new Error('Unbalanced function');
        return call(token.toLowerCase(), a);
      }
      throw new Error('Unsupported expression');
    }
    const result = expression();
    if (pos !== tokens.length || result.some(v => !Number.isFinite(v))) throw new Error('Invalid Taylor expansion');
    return result;
  }
  try {
    const functionNames = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'exp', 'ln', 'log', 'sqrt', 'abs', 'asin', 'acos', 'atan', 'arcsin', 'arccos', 'arctan']);
    const cleanedSource = source.replace(/\\(?:left|right)\b/g, '').replace(/\\([A-Za-z]+)/g, '$1');
    const identifiers = cleanedSource.match(/[A-Za-z]+/g) || [];
    const variable = identifiers.map(id => id.length === 1 ? id : '')
      .find(id => id && !functionNames.has(id.toLowerCase()) && id !== 'e');
    if (!variable) throw new Error('No expansion variable');
    const a = evaluate(center, null, variable)[0], x = constant(a);
    if (n > 1) x[1] = 1;
    const coefficients = evaluate(source, x, variable);
    const centerTex = center.replace(/\\?pi/g, '\\pi');
    const diff = a === 0 ? variable : centerTex.startsWith('-') ? '(' + variable + ' + ' + centerTex.slice(1) + ')' : '(' + variable + ' - ' + centerTex + ')';
    function format(value) {
      if (value === 0) return '0';
      if (value >= 1e21) {
        const [mantissa, exponent] = value.toExponential(4).split('e');
        return mantissa.replace(/\.?0+$/, '') + '\\times 10^{' + Number(exponent) + '}';
      }
      const integer = Math.round(value);
      const tolerance = 1e-10 * Math.max(1, value);
      if (integer !== 0 && Math.abs(value - integer) < tolerance) return String(integer);
      for (let denominator = 2; denominator <= 100; denominator++) {
        const numerator = Math.round(value * denominator);
        if (numerator > 0 && Math.abs(value - numerator / denominator) < 1e-10 * Math.max(1, value))
          return '\\frac{' + numerator + '}{' + denominator + '}';
      }
      return value.toFixed(4).replace(/\.?0+$/, '');
    }
    const terms = [];
    coefficients.forEach((value, k) => {
      // Suppress roundoff at special trigonometric centers, preserving small
      // coefficients at zero and the requested high-order terms.
      if (a !== 0 && Math.abs(value) < 1e-14) value = 0;
      const coefficient = format(Math.abs(value));
      if (coefficient === '0') return;
      const monomial = k === 0 ? '' : k === 1 ? diff : diff + '^{' + k + '}';
      const term = k === 0 ? coefficient : (coefficient === '1' ? '' : coefficient + ' ') + monomial;
      terms.push((terms.length ? (value < 0 ? ' - ' : ' + ') : (value < 0 ? '-' : '')) + term);
    });
    return (terms.join('') || '0') + ' + \\mathcal{o}(' + diff + (n === 1 ? '' : '^{' + n + '}') + ')' + (m[4] || '') + '$0';
  } catch (_) {
    return unchanged();
  }
}


// Content only: literal math delimiters belong in the text snippet template.
function gen_taylor_approx_body(m) {
  return gen_taylor_approx(m).replace(/\s*\$0$/, '').trim();
}

function gen_taylor_approx_text(m) {
  return '\\$' + gen_taylor_approx_body(m) + '\\$' + (m[4] || ' ') + '$0';
}

const FIBERED_TERM_REGEX = /^(sin|cos|arccot|cot|tan|sec|csc|ln|exp|det|arcsin|arccos|arctan|arccot|arccsc|arcsec|min|max|arg|dim|ker|det|trace|range|sqn|Aut|Hom|Mor|Ob|Iso|End|Inn|Out|GL|SL|SO|Tor|Ext|Ann|Ass|Div|Pic|Spec|Proj|Ker|dom|codom|lcm|lcf|gcd|hcf|gcf|sign|const|log|deg|rad|hom|coker|nil|Nil|jac|Jac|codim|disc|adj|Range|rank|Rank|Nul|Col|Row|Span|diag|Image|card|Perv|Var|Isom|Map|Nat|Lan|Ran|Arr|Sh|PShDesc|Fib|DFib|Gr|Fact|TS|Tot|Res|gr|rk|cf|Cone|Cocone|Disc|Bun|Rep|Ind|Coind|Alt|Mult|calP|BC|Ht|nul|trdeg|inr|Sub|Fam|H|Ch|CoCh|Comp|Ho|inf|sup|tr|im|cl|Sp|Pr)?(ds|sf|bb|bs|bf|bm|rm|cal|scr|frk)?(alpha|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|[A-Za-z0-9]|\((?:[^()]|\([^()]*\))*\))('*|\*+|\d+|_[A-Za-z0-9]+)?(ovl|udl|ovb|udb|bar|bre|hat|til|dot|vec|itr|conj|trans|what|wtil|sqr)?/;
const FIBERED_OP_REGEX = /^([-+=:<>\/]|perp|cir|com|nabla|notin|defeq|bot|top|iso|ito|isto|sto|mto|eto|lto|mid|Mid|nmid|cap|bcap|Cap|cup|bcup|Cup|vee|Vee|subp|sube|subn|supp|supe|supn|neq|geq|leq|bast|Ast|star|Star|sharp|ilim|dlim|plim|lim|colim|scup|sqcap|bscup|bsqcap|seq|noe|nop|aeq|cleq|lhd|rhd|equ|opl|Opl|upl|Upl|ts|Ts|amal|wed|bwed|bvee|dia|para|lx|prop|odot|Odot|dagg|idp|longto|from|longfrom|sum|dsum|prd|dprd|coprd|lapla|curl|dive|grad|To|Longto|sim|bd|pdx|pdy|pdz|pdt|ddx|ddy|ddz|ddt|bd|neg|id|Id|bull|heart|hbar|pm|bx|Im|Re|Pi|to|sup|gg|sub|approx|ne|ge|le|x|bx|X|pre|suc|npre|nsuc|pree|suce|dto|trto|xsto|adju|flat|ast|iff|Iff|int|ell|not|pi|ll|in|ni)/;
const FIBERED_MOD_REGEX = /^(ud|ov|uo|ou)/;

function formatFiberedTerm(p, state) {
  if (!p) return '';
  const fn = p[1] || '';
  const font = p[2] || '';
  const base = p[3] || '';
  const sub = p[4] || '';
  const acc = p[5] || '';

  if (base.startsWith('(') && base.endsWith(')')) {
    const inner = base.slice(1, -1);
    state = state || { tabIdx: 1 };
    const parsedInner = inner.trim() ? parseFiberedChain(inner, state) : '$' + state.tabIdx++;
    let atom = fn ? ('\\' + fn + '(' + parsedInner + ')') : ('(' + parsedInner + ')');
    if (font) atom = '\\' + font + '{' + atom + '}';
    if (acc) atom = '\\' + acc + '{' + atom + '}';
    if (sub) {
      if (sub.startsWith("'")) atom += sub;
      else if (sub === '*') atom += '_*';
      else if (sub.startsWith('_')) atom += sub;
      else if (sub.length === 1) atom += '_' + sub;
      else atom += '_{' + sub + '}';
    }
    return atom;
  }

  const isGreek = /^(alpha|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/.test(base);

  let atom = isGreek ? ('\\' + base) : base;
  if (font) atom = '\\' + font + '{' + atom + '}';
  if (acc) atom = '\\' + acc + '{' + atom + '}';
  if (sub) {
    if (sub.startsWith("'")) atom += sub;
    else if (sub === '*') atom += '_*';
    else if (sub.startsWith('_')) atom += sub;
    else if (sub.length === 1) atom += '_' + sub;
    else atom += '_{' + sub + '}';
  }
  return fn ? ('\\' + fn + '(' + atom + ')') : atom;
}















































































































































































































































































// >>> FIBERED_IGNORED_WORDS
// Generated by tools/generate-ignored-words.mjs — do not edit by hand.
// 2953 words from tools/words.txt that `evil_text` would otherwise
// rewrite. Keyed on the lower-cased candidate, which is what
// `shouldIgnoreFiberedInput` looks up.
const FIBERED_IGNORED_WORDS = new Set([
  'abd', 'abdalla', 'abdu', 'abdulla', 'abreast', 'acoma', 'addy', 'adjoin',
  'adjoining', 'adjoins', 'adjoint', 'adjourns', 'aflatoxin', 'age', 'aged', 'agee',
  'ageing', 'agen', 'agents', 'ager', 'ages', 'agg', 'aid', 'aida',
  'aide', 'aiding', 'aids', 'ain', 'aina', 'aine', 'ainu', 'aiso',
  'ale', 'alec', 'alegre', 'alehouse', 'alene', 'alerts', 'ales', 'aleuts',
  'alex', 'alexa', 'alexi', 'all', 'alla', 'alle', 'allege', 'alleged',
  'alleges', 'allein', 'allele', 'alleles', 'allg', 'alli', 'allin', 'allington',
  'allison', 'allo', 'allots', 'allowed', 'alls', 'allston', 'allude', 'alluded',
  'alludes', 'alluding', 'ally', 'allying', 'alpha', 'alta', 'alte', 'although',
  'alto', 'alton', 'altos', 'amid', 'amida', 'amide', 'amido', 'ane',
  'anet', 'aneuploid', 'aneuploidy', 'anew', 'anna', 'annalen', 'annales', 'anne',
  'annex', 'annexe', 'annexing', 'anni', 'anniston', 'anno', 'announce', 'anns',
  'annu', 'annulling', 'anny', 'aout', 'api', 'apia', 'apis', 'apm',
  'apres', 'argall', 'argo', 'args', 'argu', 'arguing', 'argyle', 'argyll',
  'arrowed', 'asimov', 'asse', 'assets', 'assi', 'assn', 'asso', 'assr',
  'asst', 'aston', 'astor', 'ato', 'atoll', 'atolls', 'atom', 'aton',
  'atone', 'atoned', 'atoning', 'atop', 'atopy', 'ats', 'aud', 'aude',
  'audi', 'auditor', 'audits', 'auth', 'auto', 'autogenous', 'avec', 'awed',
  'ax', 'axe', 'axilla', 'axle', 'axles', 'axtell', 'bast', 'basta',
  'baste', 'basti', 'bastide', 'bastile', 'bastille', 'basting', 'bba', 'bbb',
  'bbc', 'bbl', 'bbs', 'bell', 'bella', 'belle', 'belli', 'bellinger',
  'bellini', 'bello', 'bellowed', 'bells', 'belly', 'beta', 'betaine', 'beton',
  'bfi', 'bhat', 'bid', 'bidding', 'biddle', 'bide', 'biding', 'bids',
  'bidwell', 'biff', 'bin', 'bina', 'bind', 'binding', 'bine', 'bing',
  'binge', 'bingen', 'binges', 'bingley', 'binh', 'bini', 'binkley', 'binney',
  'bins', 'bint', 'bison', 'ble', 'bleb', 'bled', 'bles', 'bleu',
  'bleuler', 'blevins', 'blew', 'blimp', 'bma', 'bmc', 'bmd', 'bmi',
  'bmj', 'bmp', 'bmr', 'bms', 'bmt', 'bmw', 'bou', 'boudin',
  'bough', 'boughton', 'boulding', 'boule', 'boulez', 'boulogne', 'boulton', 'bouma',
  'bouncing', 'bound', 'bounding', 'bour', 'bourg', 'bourges', 'bourget', 'bourke',
  'bourn', 'bourne', 'bournemouth', 'bouse', 'bout', 'bouton', 'boutros', 'bouts',
  'boutwell', 'bove', 'bovine', 'bpi', 'bpm', 'bsa', 'bsc', 'bsd',
  'bse', 'bsi', 'bsn', 'bsp', 'bss', 'bst', 'bts', 'bud',
  'buda', 'budd', 'budding', 'bude', 'budge', 'budged', 'budget', 'budgeting',
  'budgets', 'buds', 'buna', 'bund', 'bundle', 'bundled', 'bundles', 'bung',
  'bungled', 'bunk', 'bunn', 'bunnell', 'buns', 'bunt', 'bunting', 'buon',
  'buona', 'buoy', 'buoys', 'bx', 'cala', 'calabar', 'calc', 'calcining',
  'calcitonin', 'cale', 'calf', 'calhoun', 'cali', 'calibre', 'calkins', 'call',
  'callin', 'calling', 'callisto', 'callous', 'calm', 'calming', 'cals', 'calvin',
  'calving', 'calvino', 'calx', 'calyx', 'cards', 'cardwell', 'cast', 'casta',
  'castanea', 'castanets', 'caste', 'castell', 'castelli', 'castello', 'castells', 'castile',
  'castilla', 'castille', 'castillo', 'casting', 'castle', 'castles', 'castleton', 'casts',
  'cbd', 'cell', 'cella', 'celle', 'cellini', 'cello', 'celloidin', 'cells',
  'cellule', 'cellules', 'cfa', 'cfc', 'cfd', 'cfe', 'cfi', 'cfl',
  'cfm', 'cfo', 'cfp', 'cfr', 'cfs', 'cft', 'cfu', 'cge',
  'cha', 'chabot', 'chain', 'chaine', 'chaining', 'chains', 'chalet', 'chalets',
  'challoner', 'chanel', 'chaney', 'chapin', 'chapitre', 'chasuble', 'chat', 'chats',
  'chatto', 'chc', 'chd', 'che', 'cheney', 'chewed', 'chf', 'chi',
  'chile', 'chiles', 'chill', 'chilli', 'chilling', 'chills', 'chilly', 'chilton',
  'chine', 'chiton', 'chl', 'chm', 'cho', 'choler', 'cholla', 'chopin',
  'chp', 'chr', 'christo', 'christology', 'christos', 'chs', 'cht', 'chu',
  'chugging', 'chyle', 'cid', 'cida', 'cin', 'cina', 'cine', 'cinq',
  'citrine', 'civ', 'cla', 'claud', 'claude', 'claudine', 'clawed', 'claxton',
  'clc', 'cle', 'clea', 'cleaned', 'cleaner', 'cleats', 'clef', 'clefts',
  'clegg', 'clem', 'cleo', 'clerke', 'clerks', 'cles', 'clew', 'cli',
  'climatology', 'climax', 'climb', 'climbing', 'clime', 'cline', 'clines', 'clk',
  'cll', 'clo', 'clogging', 'cloisonne', 'clone', 'cloned', 'clones', 'clots',
  'clouded', 'cloven', 'clover', 'cloves', 'clovis', 'clp', 'clr', 'cls',
  'clt', 'clu', 'cne', 'cola', 'cold', 'cole', 'coli', 'coll',
  'collide', 'colliding', 'collin', 'collins', 'collude', 'colluding', 'colm', 'colo',
  'colonel', 'coloured', 'cols', 'colston', 'colt', 'colvin', 'colwell', 'compa',
  'compelling', 'compile', 'compiled', 'compiler', 'compiles', 'compl', 'compline', 'compo',
  'components', 'comps', 'compt', 'cones', 'coney', 'consti', 'constr', 'copleston',
  'cosa', 'cose', 'cosh', 'cosi', 'cosine', 'cosines', 'coss', 'cost',
  'costello', 'costing', 'cosy', 'cota', 'cote', 'cots', 'cott', 'cottle',
  'cou', 'couch', 'coucy', 'coues', 'cough', 'coughing', 'could', 'couldst',
  'coulee', 'coulton', 'coun', 'councell', 'counsell', 'counselling', 'count', 'counting',
  'countrv', 'country', 'counts', 'coup', 'coupe', 'couple', 'coupled', 'coupler',
  'couples', 'couplet', 'couplets', 'coupling', 'coups', 'cour', 'courage', 'courageous',
  'courageously', 'cournot', 'cours', 'coursing', 'court', 'courting', 'courtney', 'courts',
  'cousin', 'cousins', 'cout', 'coutts', 'cov', 'cove', 'covets', 'covington',
  'cpi', 'cpm', 'csce', 'cscl', 'cto', 'cts', 'cud', 'cuddle',
  'cuddled', 'cudgel', 'cuo', 'cuomo', 'cx', 'cxi', 'cxix', 'damals',
  'dell', 'della', 'delle', 'dellinger', 'dello', 'dells', 'delta', 'detain',
  'detaining', 'detains', 'detox', 'dge', 'diagn', 'did', 'diddle', 'didi',
  'didn', 'dido', 'diff', 'diffi', 'dime', 'dimming', 'dimple', 'dimpled',
  'dimples', 'dims', 'din', 'dina', 'dine', 'ding', 'dinge', 'dingell',
  'dingle', 'dingley', 'dinh', 'dini', 'dining', 'dink', 'dinner', 'dino',
  'dint', 'disco', 'discoid', 'discouraging', 'discourse', 'discourteous', 'discover', 'discovering',
  'discs', 'disowned', 'distorts', 'div', 'diva', 'dive', 'divi', 'divide',
  'dividing', 'divin', 'divina', 'divine', 'divined', 'diviner', 'divines', 'diving',
  'divining', 'divino', 'divisor', 'dle', 'dll', 'dlls', 'dne', 'dolph',
  'dolphin', 'dolphins', 'domain', 'domaine', 'domains', 'dome', 'domi', 'domine',
  'dominoes', 'domo', 'doms', 'dou', 'douai', 'douay', 'double', 'doubled',
  'doubler', 'doubles', 'doublet', 'doublets', 'doubling', 'doubt', 'doubting', 'doubts',
  'douce', 'doug', 'dough', 'doun', 'dour', 'douro', 'douse', 'doute',
  'doux', 'douze', 'dov', 'dove', 'dpi', 'dpm', 'dsa', 'dsb',
  'dsc', 'dsi', 'dsl', 'dsm', 'dsn', 'dso', 'dsp', 'dsr',
  'dss', 'dst', 'dsu', 'dts', 'dud', 'duda', 'dude', 'duds',
  'duo', 'duomo', 'duong', 'duos', 'duple', 'duplex', 'dx', 'east',
  'eastbound', 'eastbourne', 'eastside', 'eddy', 'eddying', 'eells', 'eger', 'egerton',
  'egg', 'eggleston', 'eggs', 'eid', 'eide', 'ein', 'einaudi', 'eine',
  'einige', 'einigen', 'einiger', 'ele', 'elec', 'elector', 'elects', 'elem',
  'elev', 'eley', 'elim', 'ell', 'ella', 'elle', 'ellington', 'ellison',
  'elliston', 'ello', 'ells', 'elly', 'elton', 'enda', 'ende', 'endo',
  'endogenous', 'endotoxin', 'endotoxins', 'endowed', 'ends', 'ene', 'ened', 'eould',
  'epi', 'epic', 'epitope', 'epm', 'esqr', 'estar', 'esto', 'estos',
  'estoy', 'eta', 'etats', 'eto', 'etoh', 'etoile', 'eton', 'ets',
  'etsi', 'ex', 'exc', 'excelling', 'exciton', 'excludable', 'excluded', 'excludes',
  'exe', 'exh', 'exile', 'exiled', 'exiles', 'exits', 'exmouth', 'exner',
  'exo', 'exogenous', 'exotoxin', 'exp', 'expe', 'expelling', 'expiring', 'expl',
  'expo', 'exponents', 'expound', 'expounding', 'expr', 'expres', 'expt', 'ext',
  'extant', 'extol', 'extolled', 'extolling', 'exton', 'extra', 'extraneous', 'extranet',
  'extrude', 'extruded', 'extruder', 'extruding', 'exude', 'exuded', 'exudes', 'exuding',
  'facta', 'factfinding', 'factious', 'facto', 'facts', 'fama', 'fame', 'famille',
  'famine', 'famines', 'famously', 'fast', 'fastened', 'fastener', 'fasti', 'fastidious',
  'fasting', 'fasts', 'fcap', 'fell', 'fella', 'felling', 'fellini', 'fells',
  'fibrin', 'fibrine', 'fibrinogen', 'fibrinoid', 'fibrinous', 'fibrous', 'fid', 'fiddle',
  'fiddled', 'fiddler', 'fiddles', 'fide', 'fidget', 'fidgeting', 'fidler', 'fido',
  'fin', 'fina', 'finale', 'finales', 'finally', 'find', 'findeth', 'finding',
  'findley', 'fine', 'finger', 'fingering', 'fini', 'fining', 'fink', 'finley',
  'finn', 'finned', 'finney', 'fino', 'fins', 'flea', 'fled', 'fledged',
  'flee', 'fleeing', 'fleets', 'flem', 'fleming', 'flew', 'flex', 'flexing',
  'flexner', 'fll', 'fou', 'fouad', 'foul', 'foule', 'fouled', 'fouling',
  'foully', 'fouls', 'foun', 'found', 'founding', 'fount', 'founts', 'four',
  'foure', 'fours', 'fov', 'fpm', 'fto', 'ftom', 'fts', 'fudge',
  'fuori', 'fx', 'gamal', 'gamma', 'gast', 'gastrin', 'gell', 'gelling',
  'gellner', 'ghat', 'gid', 'gidding', 'gide', 'gin', 'gina', 'ging',
  'ginger', 'gini', 'ginn', 'ginning', 'gino', 'gins', 'giv', 'givin',
  'giving', 'gle', 'gleaned', 'gleaner', 'gleb', 'glee', 'glen', 'godot',
  'gouda', 'gouge', 'gouged', 'gouges', 'gough', 'gouging', 'gould', 'goulding',
  'gouldner', 'goulet', 'goupil', 'gourd', 'gourmet', 'gout', 'gouty', 'gov',
  'gove', 'govind', 'govt', 'gpi', 'gpm', 'gra', 'grabar', 'grain',
  'grainger', 'graining', 'grains', 'grainy', 'gre', 'gregg', 'grene', 'greta',
  'gri', 'grigg', 'griggs', 'grill', 'grille', 'grilling', 'grillo', 'grills',
  'grits', 'grm', 'gro', 'groggy', 'groin', 'groins', 'groove', 'grooving',
  'groovy', 'groton', 'groucho', 'grouchy', 'groundnuts', 'groundswell', 'grouped', 'grouper',
  'groupes', 'grouping', 'groupthink', 'grouted', 'grovel', 'groveling', 'grovelling', 'grover',
  'groves', 'grp', 'grs', 'grt', 'gru', 'gruelling', 'grune', 'gruner',
  'gto', 'gud', 'gude', 'guo', 'gx', 'ha', 'hage', 'hagen',
  'hager', 'hagg', 'haggle', 'haggling', 'haida', 'hain', 'haine', 'hale',
  'haled', 'hales', 'haley', 'halim', 'hall', 'halle', 'hallo', 'hallowed',
  'halls', 'hallux', 'halton', 'hamid', 'hanes', 'haney', 'hast', 'hasta',
  'haste', 'hastened', 'hasting', 'hasty', 'hats', 'haud', 'hb', 'hc',
  'hcfa', 'hd', 'he', 'hecome', 'hegel', 'heger', 'heide', 'heidi',
  'hein', 'heine', 'heing', 'heinlein', 'heinous', 'heinz', 'hele', 'helen',
  'helene', 'hell', 'helle', 'hellenes', 'hello', 'hells', 'heneage', 'heparan',
  'heston', 'hewed', 'hex', 'hexane', 'hf', 'hg', 'hh', 'hi',
  'hid', 'hidatsa', 'hide', 'hideous', 'hideout', 'hiding', 'higgins', 'higgs',
  'hiin', 'hile', 'hill', 'hillhouse', 'hills', 'hillside', 'hilltop', 'hilltops',
  'hilly', 'hilton', 'hin', 'hina', 'hinc', 'hind', 'hindley', 'hindlimb',
  'hine', 'hines', 'hing', 'hinge', 'hinged', 'hinges', 'hinkle', 'hint',
  'hinting', 'hints', 'histo', 'histology', 'histone', 'histones', 'histor', 'hits',
  'hiv', 'hj', 'hk', 'hl', 'hm', 'hn', 'hoa', 'hoax',
  'hob', 'hobbling', 'hobbs', 'hobby', 'hoc', 'hod', 'hodge', 'hodges',
  'hoe', 'hoeing', 'hof', 'hog', 'hoh', 'hoi', 'hol', 'holcomb',
  'holger', 'holler', 'hollering', 'holley', 'holston', 'holton', 'homa', 'homage',
  'home', 'homecoming', 'homi', 'homine', 'hominem', 'homines', 'homo', 'homogeneous',
  'homogeneously', 'homogenous', 'homs', 'hon', 'honing', 'honour', 'honouring', 'honours',
  'hoo', 'hoole', 'hooton', 'hoots', 'hoover', 'hooves', 'hop', 'hopi',
  'hopton', 'hor', 'hormone', 'hormones', 'horne', 'horned', 'horner', 'hornet',
  'hornets', 'horney', 'horton', 'hos', 'hosts', 'hot', 'hotelling', 'hou',
  'houck', 'houdini', 'houdon', 'houfe', 'hough', 'houghton', 'hould', 'hound',
  'hounding', 'hour', 'houre', 'hours', 'hous', 'house', 'housing', 'housings',
  'houston', 'hout', 'hov', 'hove', 'how', 'howell', 'howells', 'howled',
  'howler', 'howley', 'hox', 'hoy', 'hoyle', 'hp', 'hq', 'hr',
  'hs', 'hsin', 'hsing', 'htm', 'htp', 'htr', 'hts', 'httle',
  'htv', 'hu', 'hud', 'huddle', 'huddled', 'huddleston', 'huddling', 'huge',
  'huger', 'hugging', 'huggins', 'hull', 'hullo', 'hulls', 'hulton', 'humid',
  'huo', 'huon', 'huston', 'huts', 'huxley', 'hv', 'hw', 'hx',
  'hy', 'hylton', 'hynes', 'hz', 'ibd', 'ige', 'igg', 'ihat',
  'iid', 'iin', 'ile', 'ileo', 'iles', 'ilex', 'ill', 'illa',
  'ille', 'illi', 'illo', 'ills', 'illud', 'illy', 'ima', 'image',
  'imaged', 'imagen', 'imager', 'images', 'imax', 'imc', 'imd', 'ime',
  'imf', 'img', 'imi', 'imm', 'imo', 'imogen', 'imogene', 'imovie',
  'imp', 'impasto', 'impelling', 'impious', 'impound', 'impounding', 'imr', 'ims',
  'imt', 'inde', 'index', 'indexing', 'indi', 'indigenes', 'indigenous', 'indigents',
  'indo', 'indole', 'indu', 'indwelling', 'indy', 'ine', 'ined', 'ines',
  'inez', 'infill', 'infilling', 'infix', 'infl', 'info', 'infringe', 'infringed',
  'infringer', 'infringes', 'infringing', 'inna', 'inne', 'innovating', 'inns', 'inra',
  'iota', 'iou', 'ious', 'ipi', 'ipm', 'isospin', 'isto', 'ito',
  'itoh', 'its', 'iud', 'iuds', 'ix', 'jace', 'jack', 'jacking',
  'jamal', 'jell', 'jelliffe', 'jellinek', 'jello', 'jelly', 'jiffy', 'jin',
  'jina', 'jing', 'jingle', 'jingled', 'jingles', 'jinn', 'jinx', 'joplin',
  'jou', 'joue', 'jouer', 'joule', 'joules', 'jour', 'journ', 'journey',
  'journeying', 'jours', 'joust', 'jousting', 'jousts', 'jove', 'jts', 'jud',
  'juda', 'judd', 'jude', 'judex', 'judg', 'judge', 'judged', 'judges',
  'judging', 'judi', 'judo', 'judy', 'jx', 'kamal', 'kamala', 'kappa',
  'kast', 'kastner', 'kbar', 'kell', 'kellner', 'kellogg', 'kells', 'kelly',
  'keratoplasty', 'kerb', 'keri', 'kerk', 'kern', 'kerning', 'kerogen', 'kerr',
  'kerwin', 'keto', 'ketone', 'ketones', 'kid', 'kidd', 'kidding', 'kidney',
  'kido', 'kids', 'kin', 'kina', 'kind', 'kindle', 'kindled', 'kindles',
  'kine', 'king', 'kinge', 'kingpin', 'kingston', 'kinin', 'kink', 'kinking',
  'kinney', 'kino', 'kins', 'kinsella', 'kinsley', 'klebsiella', 'klee', 'kleenex',
  'klein', 'kleine', 'kleinen', 'kleiner', 'klima', 'klimt', 'knee', 'kneecap',
  'kneeled', 'knell', 'kneller', 'knew', 'knopf', 'knot', 'knots', 'knott',
  'knotting', 'kou', 'kpmg', 'kudo', 'kudu', 'kuo', 'kx', 'lambda',
  'lana', 'lancing', 'land', 'landing', 'landslide', 'lane', 'lang', 'langley',
  'langner', 'langston', 'langton', 'languor', 'lani', 'lank', 'lanning', 'lans',
  'lansing', 'lant', 'lanz', 'last', 'lasting', 'lasts', 'leto', 'lhat',
  'lid', 'lida', 'liddell', 'liddle', 'lido', 'lids', 'lin', 'lina',
  'linc', 'lind', 'lindley', 'lindner', 'line', 'ling', 'linger', 'lingering',
  'lining', 'link', 'linking', 'linley', 'linn', 'linne', 'linnell', 'linnet',
  'lino', 'lint', 'linux', 'linz', 'liston', 'liv', 'livid', 'livin',
  'living', 'livingston', 'livingstone', 'lle', 'lll', 'llll', 'lna', 'lnc',
  'lnd', 'lng', 'lns', 'lnt', 'loge', 'logging', 'logo', 'logs',
  'logy', 'lou', 'loud', 'loue', 'louella', 'lough', 'louie', 'louis',
  'lounge', 'lounged', 'lounger', 'lounges', 'lounging', 'loup', 'lour', 'lous',
  'louse', 'lousy', 'lout', 'louth', 'louts', 'louvain', 'louw', 'lov',
  'love', 'lovell', 'lovin', 'loving', 'lovins', 'lpm', 'lts', 'lud',
  'ludi', 'ludington', 'luo', 'luogo', 'lx', 'lxi', 'lxix', 'lxv',
  'lxx', 'lxxi', 'lxxiv', 'lxxix', 'lxxv', 'lxxx', 'lxxxi', 'lxxxiv',
  'lxxxix', 'lxxxv', 'mapa', 'mapi', 'mapk', 'mapp', 'maps', 'maputo',
  'mast', 'mastiff', 'mastoid', 'masts', 'maxi', 'maxilla', 'maxine', 'maxwell',
  'mbar', 'mbd', 'mell', 'mello', 'mellowed', 'mid', 'middle', 'middleaged',
  'middles', 'middleton', 'mideast', 'midge', 'midges', 'midget', 'midgets', 'midgley',
  'midi', 'midler', 'midline', 'midpoint', 'midpoints', 'midriff', 'mifflin', 'min',
  'mina', 'minato', 'mincing', 'mind', 'minding', 'mine', 'ming', 'mingle',
  'mingled', 'mingles', 'minh', 'mini', 'minima', 'minimally', 'minimax', 'minime',
  'minimi', 'minims', 'mining', 'mink', 'minn', 'minne', 'minnelli', 'mino',
  'mins', 'mint', 'minting', 'minto', 'mints', 'minty', 'mintz', 'minx',
  'miso', 'mito', 'mitogen', 'mle', 'mlle', 'mne', 'mnes', 'mora',
  'moraine', 'morale', 'morales', 'morally', 'morb', 'morbid', 'more', 'morell',
  'morelli', 'moreton', 'mori', 'morillo', 'morn', 'mornin', 'morning', 'morningstar',
  'mornington', 'moro', 'morone', 'morphine', 'morrell', 'morrison', 'mors', 'mort',
  'mou', 'mould', 'moulding', 'moule', 'moulin', 'moulins', 'moult', 'moulting',
  'moulton', 'moun', 'mound', 'mount', 'mounting', 'mounts', 'moura', 'mourn',
  'mourned', 'mourner', 'mourning', 'mous', 'mouse', 'mouth', 'mouthing', 'mouton',
  'mov', 'move', 'movin', 'moving', 'mpi', 'mto', 'mts', 'mud',
  'muda', 'mudd', 'muddle', 'muddled', 'mudflats', 'mudge', 'muds', 'mudstone',
  'mudstones', 'multa', 'multi', 'multo', 'muon', 'muons', 'mx', 'nast',
  'nasty', 'nata', 'natale', 'nate', 'nath', 'nati', 'natl', 'nato',
  'nats', 'natu', 'nell', 'nella', 'nelle', 'nello', 'nelly', 'neque',
  'neto', 'nhat', 'nid', 'nida', 'nila', 'nile', 'nilo', 'nils',
  'nin', 'nina', 'nine', 'ning', 'ninh', 'nino', 'ninth', 'nitride',
  'nitriding', 'nitrous', 'niv', 'nivelle', 'nne', 'nou', 'noun', 'nouns',
  'nous', 'nouv', 'nouvelle', 'nov', 'nova', 'nove', 'novell', 'novella',
  'novelle', 'novello', 'novi', 'novo', 'novy', 'npm', 'nto', 'nts',
  'ntsb', 'ntsc', 'nu', 'nude', 'nudge', 'nudged', 'nudges', 'nudging',
  'nuggets', 'null', 'nulla', 'nulle', 'nullo', 'nulls', 'nunes', 'nunez',
  'nuova', 'nuove', 'nuovi', 'nuovo', 'nuts', 'nutshell', 'nux', 'nx',
  'oba', 'obadiah', 'obe', 'obi', 'obj', 'objeto', 'oblast', 'oblasts',
  'obote', 'obs', 'obsequious', 'obv', 'ogee', 'ogg', 'oggi', 'oid',
  'ole', 'olefin', 'olefins', 'oleg', 'oleh', 'oleo', 'olim', 'olla',
  'omega', 'one', 'onegin', 'oneida', 'onerous', 'ones', 'oould', 'opi',
  'opic', 'opie', 'opin', 'opine', 'opined', 'opines', 'opioid', 'opioids',
  'opm', 'oto', 'otol', 'otology', 'ots', 'oud', 'oude', 'oudh',
  'outa', 'outage', 'outages', 'outbid', 'outbound', 'outcast', 'outcasts', 'outdid',
  'outhouse', 'outlast', 'outline', 'outlining', 'outpouring', 'outs', 'outside', 'outsourcing',
  'owed', 'ox', 'oxid', 'oxide', 'oxime', 'oxley', 'oxo', 'oxy',
  'oxygen', 'oxytocin', 'past', 'pasta', 'paste', 'pastime', 'pasting', 'pasts',
  'pasty', 'pbx', 'pell', 'pella', 'pelle', 'pellets', 'pelling', 'pelly',
  'pequots', 'pervious', 'peto', 'pge', 'phat', 'phi', 'phidias', 'philly',
  'pi', 'pica', 'pice', 'pick', 'picking', 'pickle', 'pickled', 'pickles',
  'pico', 'pics', 'pict', 'pictou', 'piggy', 'pile', 'piled', 'piles',
  'pill', 'pillage', 'pillaged', 'pilling', 'pillowed', 'pills', 'pine', 'pined',
  'pinel', 'pinene', 'pines', 'piney', 'pinot', 'pious', 'pipit', 'pistol',
  'pistoles', 'piston', 'pisum', 'pitot', 'pitou', 'pits', 'pix', 'ple',
  'plea', 'pleats', 'pled', 'pledge', 'pledged', 'pledgee', 'pledges', 'plein',
  'pleine', 'plex', 'plimpton', 'pll', 'pne', 'pou', 'pouch', 'poul',
  'poulet', 'poulton', 'poultry', 'pouncing', 'pound', 'pounding', 'pour', 'pouring',
  'pours', 'pourtant', 'poussin', 'pout', 'pouting', 'pov', 'povidone', 'ppi',
  'ppm', 'pra', 'praetor', 'prager', 'prato', 'prb', 'prc', 'prd',
  'pre', 'presto', 'preston', 'presume', 'presuming', 'pretax', 'preto', 'prf',
  'prg', 'pri', 'prieto', 'primidone', 'prix', 'prk', 'prl', 'prm',
  'prn', 'pro', 'progenitor', 'progestogen', 'projets', 'prone', 'propio', 'propre',
  'propres', 'proto', 'proton', 'protoplast', 'protoplasts', 'protoxide', 'prouder', 'proudly',
  'provable', 'proved', 'proven', 'prover', 'proves', 'provoking', 'proximally', 'proximo',
  'proxy', 'prp', 'prr', 'prs', 'prt', 'pru', 'prudhomme', 'prune',
  'pruned', 'prunes', 'pry', 'prying', 'psi', 'pto', 'pts', 'ptsd',
  'pud', 'pudding', 'puddle', 'puddled', 'puddles', 'px', 'qid', 'qin',
  'qing', 'quo', 'quoad', 'quoc', 'quod', 'quoi', 'quoins', 'quos',
  'quot', 'quota', 'quote', 'quoth', 'quoting', 'quoy', 'qx', 'rada',
  'rade', 'radi', 'radix', 'rado', 'rads', 'radu', 'rana', 'ranchi',
  'rancid', 'rancour', 'rand', 'randle', 'randolph', 'rang', 'ranged', 'rangel',
  'ranger', 'ranges', 'ranging', 'rani', 'ranke', 'rankine', 'rankling', 'ranks',
  'rann', 'rans', 'rant', 'ranting', 'rast', 'rasta', 'repaid', 'repaint',
  'repainting', 'repelling', 'repine', 'repo', 'repousse', 'repr', 'reprint', 'reprinting',
  'reprints', 'reprove', 'reproving', 'reps', 'rept', 'requestor', 'resale', 'rescind',
  'rescinding', 'resell', 'reselling', 'resets', 'resi', 'resistor', 'resource', 'resp',
  'ress', 'rest', 'resting', 'retorts', 'rid', 'rida', 'riddell', 'ridding',
  'riddle', 'riddled', 'riddles', 'ride', 'ridge', 'ridged', 'ridges', 'ridin',
  'riding', 'ridley', 'rids', 'riff', 'riffle', 'riffles', 'riffs', 'rin',
  'rina', 'rind', 'rinding', 'ring', 'ringed', 'ringer', 'ringing', 'ringlets',
  'rink', 'rinsing', 'risotto', 'ritornello', 'riv', 'rivington', 'rko', 'rll',
  'rma', 'rmb', 'rmi', 'rms', 'rolph', 'rou', 'rouble', 'roubles',
  'roue', 'rouen', 'rouge', 'rouged', 'rouges', 'rough', 'roughing', 'roun',
  'round', 'rounding', 'roup', 'rourke', 'rous', 'rouse', 'rousing', 'rout',
  'route', 'routh', 'routine', 'routing', 'routledge', 'routs', 'roux', 'rov',
  'rove', 'roving', 'rowe', 'rowell', 'rowling', 'rows', 'rpi', 'rpm',
  'rto', 'rts', 'rud', 'rudd', 'rude', 'rudge', 'rudi', 'rudiger',
  'rudin', 'rudolph', 'rudy', 'rx', 'scap', 'scapa', 'scape', 'scire',
  'scra', 'scraggy', 'scrapie', 'screwed', 'scroggs', 'scroll', 'scrolling', 'scrolls',
  'scruggs', 'scruton', 'seca', 'secchi', 'seco', 'secs', 'sect', 'secy',
  'sell', 'sella', 'selle', 'sellin', 'selling', 'sellout', 'sells', 'sequins',
  'seto', 'seton', 'sfa', 'sfc', 'sfe', 'sfr', 'sfs', 'sft',
  'sha', 'shaggy', 'shale', 'shaler', 'shales', 'shall', 'shallots', 'shane',
  'shat', 'shc', 'shd', 'she', 'shell', 'shelling', 'shells', 'shelly',
  'shelton', 'shewed', 'shg', 'shh', 'shi', 'shigella', 'shilling', 'shine',
  'shined', 'shiner', 'shines', 'sho', 'shoddy', 'shoin', 'sholem', 'shone',
  'shots', 'shouted', 'shoved', 'shovel', 'shoveling', 'shovelling', 'shoves', 'showed',
  'shp', 'shr', 'shrine', 'shrink', 'shrinking', 'shroud', 'shrouding', 'shrove',
  'shs', 'shu', 'shudra', 'shull', 'shuts', 'shy', 'shying', 'sid',
  'sida', 'side', 'sidebar', 'sidi', 'siding', 'sidled', 'sidmouth', 'sidney',
  'sido', 'sids', 'sigma', 'signa', 'signage', 'signaled', 'signalling', 'signally',
  'signe', 'signi', 'signo', 'signs', 'sin', 'sina', 'sind', 'sindia',
  'sine', 'sing', 'singe', 'singed', 'singer', 'singin', 'singing', 'single',
  'singled', 'singles', 'singlet', 'singleton', 'sinh', 'sink', 'sinkers', 'sinking',
  'sinn', 'sinne', 'sinned', 'sinner', 'sinning', 'sinnott', 'sino', 'sins',
  'sint', 'sinuous', 'siv', 'sle', 'sled', 'sledge', 'sledges', 'slew',
  'slim', 'slime', 'slimming', 'slimy', 'sll', 'sne', 'snell', 'snellen',
  'snelling', 'snot', 'sou', 'souci', 'souffle', 'souk', 'soul', 'sould',
  'soule', 'souled', 'soules', 'souls', 'soult', 'sound', 'sounding', 'soup',
  'soups', 'sour', 'sourcing', 'souring', 'sours', 'sous', 'sousa', 'south',
  'souza', 'sov', 'spa', 'spain', 'spaine', 'spall', 'spalling', 'spangled',
  'spangler', 'spangles', 'spank', 'spanking', 'spann', 'spanning', 'spans', 'spats',
  'spb', 'spc', 'spd', 'spe', 'speci', 'specious', 'speck', 'speckle',
  'speckled', 'specs', 'spect', 'spell', 'spellbinding', 'spellbound', 'spelling', 'spells',
  'spener', 'spewed', 'spf', 'spg', 'sph', 'sphinx', 'spi', 'spie',
  'spiegel', 'spielen', 'spiking', 'spill', 'spillage', 'spillane', 'spilled', 'spiller',
  'spilling', 'spillover', 'spills', 'spin', 'spine', 'spined', 'spinel', 'spinelli',
  'spines', 'spinet', 'spinner', 'spinous', 'spirito', 'spit', 'spits', 'spl',
  'spline', 'splint', 'splinting', 'splints', 'spm', 'spo', 'spoleto', 'spots',
  'spousal', 'spouses', 'spouted', 'spp', 'spr', 'spree', 'sprees', 'sprengel',
  'sprenger', 'spring', 'springer', 'springing', 'sprinkle', 'sprinkled', 'sprinkler', 'sprinkles',
  'sprint', 'sprinting', 'sprints', 'sproul', 'sprout', 'sprouting', 'sprouts', 'sps',
  'spt', 'spx', 'spy', 'spying', 'stil', 'stille', 'stilled', 'stiller',
  'stilton', 'stilts', 'sto', 'stoa', 'stokers', 'stoking', 'stol', 'stole',
  'stolen', 'stolid', 'stoll', 'stoller', 'ston', 'stone', 'stoned', 'stonehouse',
  'stoner', 'stones', 'stoney', 'stoning', 'stonington', 'stooge', 'stooges', 'stop',
  'stope', 'stoping', 'stopover', 'stops', 'stopt', 'stor', 'storing', 'storks',
  'storms', 'stormy', 'stow', 'stowed', 'stowell', 'stowing', 'sts', 'suba',
  'subd', 'subdivide', 'subdividing', 'subito', 'subj', 'subroutine', 'subs', 'subside',
  'subsiding', 'subsidy', 'subtle', 'subtler', 'sud', 'suda', 'suds', 'suo',
  'suoh', 'suoi', 'suomi', 'suos', 'supine', 'supp', 'supple', 'supt',
  'swede', 'sx', 'tamale', 'tana', 'tanager', 'tand', 'tane', 'tanf',
  'tang', 'tangle', 'tangled', 'tangles', 'tani', 'tank', 'tannin', 'tanning',
  'tannins', 'tans', 'tant', 'tanu', 'taste', 'tasting', 'tasty', 'tau',
  'tauler', 'tautology', 'taux', 'tell', 'telle', 'tellin', 'telling', 'tello',
  'tells', 'telly', 'teton', 'that', 'theta', 'tid', 'tide', 'tidy',
  'tidying', 'tiff', 'tiffin', 'tin', 'tina', 'tine', 'ting', 'tinge',
  'tinged', 'tinges', 'tingle', 'tingled', 'tink', 'tinkers', 'tinkle', 'tinkled',
  'tinned', 'tinning', 'tino', 'tins', 'tinsley', 'tint', 'tinting', 'tinto',
  'tints', 'tiny', 'tito', 'tiv', 'tle', 'tll', 'tlx', 'tne',
  'tora', 'tore', 'tori', 'tork', 'torn', 'toro', 'torr', 'torrid',
  'torrington', 'tors', 'tort', 'tortuous', 'toru', 'tory', 'tota', 'totale',
  'totaled', 'totalling', 'totally', 'tote', 'toth', 'toto', 'tots', 'tou',
  'touch', 'touchstone', 'touchstones', 'tough', 'toul', 'toulmin', 'toun', 'tour',
  'touraine', 'toure', 'touring', 'tourmaline', 'tourney', 'tours', 'tous', 'tousled',
  'tout', 'toute', 'touting', 'touts', 'tov', 'tpi', 'tpm', 'tra',
  'traced', 'tracer', 'traces', 'tracey', 'tragedian', 'trager', 'train', 'training',
  'trains', 'traitor', 'traitorous', 'tralee', 'trc', 'tre', 'trf', 'trh',
  'tri', 'trigg', 'trill', 'trilling', 'trills', 'trine', 'triton', 'tritone',
  'tro', 'troll', 'trolling', 'trolls', 'tropic', 'trots', 'troubadour', 'troubadours',
  'troughs', 'troupes', 'trouser', 'trouver', 'trover', 'trp', 'trs', 'trt',
  'tru', 'trudgill', 'trustor', 'trw', 'try', 'tryin', 'trying', 'tryout',
  'tryouts', 'tto', 'tts', 'tude', 'tuo', 'tuple', 'tx', 'txt',
  'uid', 'uinta', 'ule', 'ull', 'ulla', 'une', 'unef', 'unep',
  'unes', 'unopened', 'upi', 'upsilon', 'usum', 'util', 'uto', 'uts',
  'ux', 'vara', 'vari', 'varilla', 'various', 'vars', 'vary', 'varying',
  'vast', 'vaste', 'vella', 'velle', 'veto', 'vetoing', 'vhat', 'vid',
  'vida', 'vide', 'vidi', 'vin', 'vina', 'vine', 'ving', 'vinh',
  'vini', 'vining', 'vino', 'vinogradov', 'vinous', 'vins', 'vint', 'vintage',
  'vintages', 'vintner', 'visor', 'visto', 'vito', 'viv', 'vivid', 'vll',
  'vlll', 'vne', 'volpe', 'volpone', 'vou', 'vouch', 'vould', 'voulez',
  'voulu', 'voung', 'vour', 'vous', 'vpi', 'vx', 'wast', 'wastage',
  'waste', 'wasting', 'well', 'wellcome', 'welle', 'welling', 'wellington', 'wells',
  'wellto', 'what', 'whatley', 'whatnot', 'wid', 'wide', 'widened', 'widener',
  'widget', 'widgets', 'widi', 'widowed', 'win', 'wincing', 'wind', 'winding',
  'windle', 'wine', 'wing', 'winged', 'winger', 'winging', 'wink', 'winking',
  'winkle', 'winkler', 'winn', 'winner', 'winning', 'winograd', 'wins', 'winston',
  'wint', 'wolpe', 'would', 'wouldst', 'wound', 'wounding', 'wove', 'wto',
  'wx', 'xi', 'xin', 'xing', 'xiv', 'xix', 'xixe', 'xll',
  'xx', 'xxi', 'xxix', 'xxl', 'xxm', 'xxv', 'xxx', 'xxxi',
  'xxxiv', 'xxxix', 'xxxv', 'xxxx', 'xxxxx', 'xxy', 'yell', 'yellin',
  'yelling', 'yellowed', 'yells', 'yin', 'ying', 'you', 'youl', 'youll',
  'young', 'younger', 'your', 'youre', 'yours', 'yous', 'youse', 'youth',
  'ypres', 'yx', 'zell', 'zellner', 'zeta', 'zidovudine', 'ziff', 'zin',
  'zina', 'zinc', 'zine', 'zing', 'zink', 'zinn', 'zou', 'zuo',
  'zx'
]);
// <<< FIBERED_IGNORED_WORDS


const FIBERED_IGNORED_INPUTS = new Set(['awedy']);



const FIBERED_MATH_IGNORED_WORDS = new Set([]);

function shouldIgnoreFiberedInput(input, mode = 'text') {
  const value = String(input || '').trim();
  return FIBERED_IGNORED_INPUTS.has(value) ||
    (mode === 'math' ? FIBERED_MATH_IGNORED_WORDS : FIBERED_IGNORED_WORDS).has(value.toLowerCase());
}

// JavaScript body results must not acquire extra TeX escapes on rejection.
// These triggers admit no dollar tabstop syntax inside the candidate.
function preserveFiberedInput(match) {
  return String(match[0] || '') + '$0';
}

// Only the explicitly supported TeX spacing commands may enter shorthand.
function isFiberedCandidate(source) {
  return typeof source === 'string' &&
    /^(?:\\(?:qqd|qd|[!,>:;])|[A-Za-z0-9{}()\[\]|*'"@⋅_^.,+=:<>/\-])+$/.test(source);
}

// The usual RegExp match metadata permits protection of a surrounding native
// TeX argument, comment or verbatim span. Local token guards work even when
// a snippet host passes only numbered captures.
function isFiberedProtectedContext(m) {
  if (typeof m.input !== 'string' || !Number.isInteger(m.index)) return false;
  const prefix = m.input.slice(0, m.index);
  const braces = [];
  let pendingProtected = false;
  const opaqueCommands = new Set([
    'text', 'textrm', 'textsf', 'texttt', 'textnormal', 'textup', 'textit',
    'textsl', 'textsc', 'textbf', 'textmd', 'emph', 'mbox', 'hbox',
    'operatorname', 'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref',
    'Cref', 'cite', 'url', 'path', 'begin', 'end'
  ]);
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (ch === '%') {
      const end = prefix.indexOf('\n', i);
      if (end < 0) return true;
      i = end;
    } else if (ch === '\\') {
      const verb = /^\\verb\*?([^A-Za-z\s])/.exec(prefix.slice(i));
      if (verb) {
        const end = prefix.indexOf(verb[1], i + verb[0].length);
        if (end < 0) return true;
        i = end;
      } else {
        const command = /^\\([A-Za-z]+)\*?/.exec(prefix.slice(i));
        if (command) {
          pendingProtected = opaqueCommands.has(command[1]);
          i += command[0].length - 1;
        } else { i++; pendingProtected = false; }
      }
    } else if (ch === '{') {
      braces.push(pendingProtected || braces[braces.length - 1] === true);
      pendingProtected = false;
    } else if (ch === '}') {
      braces.pop(); pendingProtected = false;
    } else if (!/\s/.test(ch)) pendingProtected = false;
  }
  return braces.some(Boolean);
}

// Plain letters, numbers and native grouping alone are not a request to
// rewrite text. Explicit operators, functions, modifiers and holes are.
function hasFiberedIntent(ast) {
  switch (ast.type) {
    case 'spacing': return false;
    case 'raw': return ast.value.startsWith('\\');
    case 'quoted': return true;
    case 'group': return hasFiberedIntent(ast.inner);
    case 'sequence': case 'concat': return ast.items.some(hasFiberedIntent);
    default: return true;
  }
}

// Parentheses must balance in the complete word, even when a boundary-based
// trigger captured only a suffix. This guard runs before any suffix fallback.
function hasBalancedFiberedParentheses(source) {
  let depth = 0;
  for (const ch of String(source || '')) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function isFiberedBalancedWord(m, index) {
  const source = String(m[index] || '');
  if (!hasBalancedFiberedParentheses(source)) return false;
  if (typeof m.input !== 'string' || !Number.isInteger(m.index)) return true;
  const offset = String(m[0] || '').indexOf(source);
  if (offset < 0) return true;
  let start = m.index + offset, end = start + source.length;
  while (start > 0 && !/\s/.test(m.input[start - 1])) start--;
  while (end < m.input.length && !/\s/.test(m.input[end])) end++;
  return hasBalancedFiberedParentheses(m.input.slice(start, end));
}

function fiberedAstForMatch(m, index, mode = 'text') {
  const source = m[index];
  if (!isFiberedCandidate(source) || !isFiberedBalancedWord(m, index) ||
    shouldIgnoreFiberedInput(source, mode) ||
    isFiberedProtectedContext(m)) return null;
  try {
    const ast = parseFiberedExpression(source);
    return ast && hasFiberedIntent(ast) ? ast : null;
  } catch (error) {
    // A very deeply nested input must remain editable if the host's stack
    // limit is reached. Do not hide unrelated programming errors.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

// Grammar and rendering for the two multi_fibered_op snippets.
// Change dictionary entries here to customize nonstandard symbol expansion.
const NONSTANDARD_SYMBOL_DICTIONARY = Object.freeze({ '\\': '\\backslash', olp: '\\olp', bslash: '\\backslash', '⋅': '' });
const FIBERED_FUNCTIONS = ["sin", "cos", "arccot", "cot", "tan", "sec", "csc", "ln", "exp", "det", "arcsin", "arccos", "arctan", "arccsc", "arcsec", "min", "max", "arg", "dim", "ker", "trace", "range", "sqn", "Aut", "Hom", "Mor", "Ob", "Iso", "End", "Inn", "Out", "GL", "SL", "SO", "Tor", "Ext", "Ann", "Ass", "Div", "Pic", "Spec", "Proj", "Ker", "dom", "codom", "lcm", "lcf", "gcd", "hcf", "gcf", "sign", "const", "log", "deg", "rad", "hom", "coker", "nil", "Nil", "jac", "Jac", "codim", "disc", "adj", "Range", "rank", "Rank", "Nul", "Col", "Row", "Span", "diag", "Image", "card", "Perv", "Var", "Isom", "Map", "Nat", "Lan", "Ran", "Arr", "Sh", "PShDesc", "Fib", "DFib", "Gr", "Fact", "TS", "Tot", "Res", "gr", "rk", "cf", "Cone", "Cocone", "Disc", "Bun", "Rep", "Ind", "Coind", "Alt", "Mult", "calP", "BC", "Ht", "nul", "trdeg", "inr", "Sub", "Fam", "H", "Ch", "CoCh", "Comp", "Ho", "inf", "sup", "tr", "im", "cl", "Sp", "Pr"]
const FIBERED_LETTERS = ["alpha", "beta", "gamma", "delta", "zeta", "eta", "varepsilon", "theta", "iota", "kappa", "vartheta", "lambda", "nu", "pi", "tau", "upsilon", "phi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"];
const FIBERED_ACCENTS = ["ovl", "udl", "ovb", "udb", "bar", "bre", "hat", "til", "dot", "vec", "itr", "conj", "trans", "what", "wtil", "sqr"];
const FIBERED_STYLES = ["ds", "sf", "bb", "bs", "bf", "bm", "rm", "cal", "scr", "frk"];
const FIBERED_SYMBOLS = ["perp", "cir", "com", "nabla", "notin", "defeq", "bot", "top", "iso", "ito", "isto", "sto", "mto", "eto", "lto", "mid", "Mid", "nmid", "cap", "bcap", "Cap", "cup", "bcup", "Cup", "vee", "Vee", "subp", "sube", "subn", "supp", "supe", "supn", "neq", "geq", "leq", "bast", "Ast", "star", "Star", "sharp", "ilim", "dlim", "plim", "lim", "colim", "scup", "sqcap", "bscup", "bsqcap", "seq", "noe", "nop", "aeq", "cleq", "lhd", "rhd", "equ", "opl", "Opl", "upl", "Upl", "ts", "Ts", "amal", "wed", "bwed", "bvee", "dia", "para", "lx", "prop", "odot", "Odot", "dagg", "idp", "longto", "from", "longfrom", "sum", "dsum", "prd", "dprd", "coprd", "lapla", "curl", "dive", "grad", "To", "Longto", "sim", "bd", "pdx", "pdy", "pdz", "pdt", "ddx", "ddy", "ddz", "ddt", "neg", "id", "Id", "bull", "heart", "hbar", "pm", "bx", "Im", "Re", "Pi", "to", "sup", "gg", "sub", "approx", "ne", "ge", "le", "x", "X", "pre", "suc", "npre", "nsuc", "pree", "suce", "dto", "trto", "xsto", "adju", "flat", "ast", "iff", "Iff", "int", "ell", "not", "pi", "ll", "in", "ni"];

const FIBERED_QUICK_SCRIPT_MAP = Object.freeze({ "a": "*", "e": "!", "h": "\\#", "sh": "\\sh", "d": "\\dagg", "f": "\\flat", "b": "\\bull" });
const FIBERED_GREEK_ALIASES = Object.freeze(Object.assign({}, GREEK, { h: "eta", p: "pi", R: "mathrm{P}" }));
const FIBERED_GREEK_ALIAS_REGEX = /^@(vth|vpi|vph|ve|vt|Th|pi|Pi|vr|vs|ta|Ph|ch|ps|Ps|th|[abgGdDeziklLmnxXrRsSuUphoO])/;

function fiberedLongest(values) {
  return Array.from(new Set(values)).sort((a, b) => b.length - a.length);
}

// Parse into an AST first: failed alternatives never consume tabstop numbers.
function parseFiberedExpression(source, relaxed = false, scriptContext = false) {
  const text = String(source);
  const functions = fiberedLongest(FIBERED_FUNCTIONS);
  const letters = fiberedLongest(FIBERED_LETTERS);
  const accents = fiberedLongest(FIBERED_ACCENTS);
  const symbols = fiberedLongest(FIBERED_SYMBOLS.concat(Object.keys(NONSTANDARD_SYMBOL_DICTIONARY)));
  const memo = new Map();
  const operands = new Map();
  const groups = new Map();
  const word = (values, p) => values.find(v => text.startsWith(v, p));
  const node = (type, fields) => Object.assign({ type }, fields);
  function spacing(p) {
    const match = /^\\(qqd|qd|[!,>:;])/.exec(text.slice(p));
    if (!match) return null;
    const value = match[1] === 'qd' ? '\\quad' : match[1] === 'qqd' ? '\\qquad' : match[0];
    return { end: p + match[0].length, ast: node('spacing', { value }) };
  }
  function group(p, allowStar = scriptContext) {
    const groupKey = p + ":" + allowStar;
    if (groups.has(groupKey)) return groups.get(groupKey);
    const open = text[p];
    if (!'{[ (|'.replace(/ /g, '').includes(open || '\0')) return null;
    let end = p + 1;
    const stack = [open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : '|'];
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === stack[stack.length - 1]) {
        stack.pop();
        if (!stack.length) break;
      } else if ('{[(|'.includes(c)) {
        stack.push(c === '{' ? '}' : c === '[' ? ']' : c === '(' ? ')' : '|');
      } else if ('}])'.includes(c)) { groups.set(groupKey, null); return null; }
    }
    if (stack.length) { groups.set(groupKey, null); return null; }
    // [[...]] is one delimiter, so an empty pair creates exactly one holder.
    const double = open === '[' && text[p + 1] === '[' && text[end - 1] === ']';
    const inner = text.slice(p + (double ? 2 : 1), end - (double ? 1 : 0));
    const ast = inner === '' ? node('hole', {}) : parseFiberedExpression(inner, true, allowStar);
    const result = ast && { end: end + 1, ast: node('group', { open: double ? '[[' : open, inner: ast }) };
    groups.set(groupKey, result || null);
    return result;
  }
  function letter(p, allowStar) {
    const alias = FIBERED_GREEK_ALIAS_REGEX.exec(text.slice(p));
    if (alias) return { end: p + alias[0].length, ast: node('raw', { value: '\\' + FIBERED_GREEK_ALIASES[alias[1]] }) };
    const greek = word(letters, p);
    if (greek) return { end: p + greek.length, ast: node('raw', { value: '\\' + greek }) };
    if (/[A-Za-z0-9]/.test(text[p] || '') || (allowStar && text[p] === '*'))
      return { end: p + 1, ast: node('raw', { value: text[p] }) };
    return null;
  }
  function base(p, allowStar, literalParenthesis = false) {
    if (literalParenthesis && (text[p] === '(' || text[p] === ')'))
      return { end: p + 1, ast: node('raw', { value: text[p] }) };
    if (text[p] === '"') {
      let q = p + 1;
      const items = [];
      while (q < text.length && text[q] !== '"') {
        const item = letter(q, allowStar);
        if (!item) return null;
        items.push(item.ast); q = item.end;
      }
      if (text[q] !== '"') return null;
      return { end: q + 1, ast: node('quoted', { inner: items.length ? node('sequence', { items }) : node('hole', {}) }) };
    }
    return group(p, allowStar) || letter(p, allowStar) ||
      ((text[p] === '(' || text[p] === ')')
        ? { end: p + 1, ast: node('raw', { value: text[p] }) } : null);
  }
  function script(p, used, allowIntermediate = true) {
    if (text[p] === '_' || text[p] === '^') {
      const kind = text[p];
      if (used.has(kind)) return null;
      let start = p + 1;
      const spaces = [];
      let gap;
      while ((gap = spacing(start))) { spaces.push(gap.ast); start = gap.end; }
      // A symbol has priority over an operand. Consume only its core here,
      // leaving the next script marker attached to the enclosing owner.
      // A complete grouped script keeps its wrapping meaning before the
      // single-character parenthesis symbol alternative.
      const grouped = text[start] === '(' && group(start, true);
      const arg = grouped ? operand(start, true, allowIntermediate)[0]
        : symbol(start, false) || operand(start, true, allowIntermediate)[0];
      if (!arg && start !== text.length) return null;
      used.add(kind);
      return {
        end: arg ? arg.end : start,
        parts: [{
          kind, ast: spaces.length
            ? node('concat', { items: spaces.concat(arg ? arg.ast : node('hole', {})) })
            : arg ? arg.ast : node('hole', {})
        }]
      };
    }
    // Functions and symbols accept scripts here; input accents are resolved
    // by decorate(), where both interpretations can occur.
    const marker = /^(ud|ov|uo|ou)/.exec(text.slice(p));
    if (!marker) return null;
    const kinds = { ud: ['_'], ov: ['^'], uo: ['_', '^'], ou: ['^', '_'] }[marker[1]];
    if (kinds.some(k => used.has(k))) return null;
    p += 2;
    const parts = [];
    for (const kind of kinds) {
      // A bare argument stops before another suffix. Wrap it to nest suffixes.
      const arg = operand(p, true, allowIntermediate)[0];
      if (arg) { p = arg.end; parts.push({ kind, ast: arg.ast }); }
      else if (p === text.length) parts.push({ kind, ast: node('hole', {}) });
      used.add(kind);
    }
    return { end: p, parts };
  }
  function decorate(item, bare, allowIntermediate) {
    let p = item.end, ast = item.ast;
    const used = new Set();
    const namedQuick = () => {
      if (text.startsWith('iv', p)) {
        if (used.has('^')) return false;
        ast = node('scripts', { inner: ast, parts: [{ kind: '^', ast: node('raw', { value: '-1' }) }] });
        used.add('^'); p += 2;
        return true;
      }
      const match = /^(['.])(sh|a|e|h|d|f|b)/.exec(text.slice(p));
      if (!match) return false;
      const kind = match[1] === "'" ? '^' : '_';
      if (used.has(kind)) return false;
      ast = node('scripts', { inner: ast, parts: [{ kind, ast: node('raw', { value: FIBERED_QUICK_SCRIPT_MAP[match[2]] }) }] });
      used.add(kind); p += match[0].length;
      return true;
    };
    while (namedQuick()) { }
    const quick = /^('+|\*+|\d+)/.exec(text.slice(p));
    if (quick) {
      p += quick[0].length;
      if (quick[0][0] === "'") ast = node('prime', { inner: ast, value: quick[0] });
      else { if (used.has('_')) return { end: p - quick[0].length, ast }; ast = node('scripts', { inner: ast, parts: [{ kind: '_', ast: node('raw', { value: quick[0] }) }] }); used.add('_'); }
    }
    if (!bare) {
      let accentUsed = false;
      for (; ;) {
        if (namedQuick()) continue;
        const styledScript = /^(ud|ov|uo|ou)/.test(text.slice(p)) && word(FIBERED_STYLES, p + 2);
        const accent = !accentUsed && !styledScript && word(accents, p);
        if (accent) { ast = node('wrap', { name: accent, inner: ast }); p += accent.length; accentUsed = true; continue; }
        const s = script(p, used);
        if (!s) break;
        ast = node('scripts', { inner: ast, parts: s.parts }); p = s.end;
      }
    }
    if (allowIntermediate && (text[p] === '(' || text[p] === '[')) {
      const g = group(p);
      // Intermediate content must be exactly one simple input (or empty).
      if (g && validIntermediate(g.ast)) { ast = node('concat', { items: [ast, g.ast] }); p = g.end; }
    }
    return { end: p, ast };
  }
  function validIntermediate(g) {
    if (g.inner.type === 'hole') return true;
    // Validate with input grammar, not the permissive group expression grammar.
    // AST validation rejects functions, symbols and further intermediates.
    function simple(a) {
      if (a.type === 'raw') return true;
      if (a.type === 'wrap' || a.type === 'prime') return simple(a.inner);
      if (a.type === 'scripts') return simple(a.inner);
      if (a.type === 'group' || a.type === 'quoted') return true;
      return a.type === 'sequence' && a.items.length === 1 && simple(a.items[0]);
    }
    return simple(g.inner);
  }
  function operand(p, bare = false, allowIntermediate = true) {
    const space = spacing(p);
    if (space) return operand(space.end, bare, allowIntermediate).map(item => ({
      end: item.end, ast: node('concat', { items: [space.ast, item.ast] })
    }));
    const key = p + ':' + bare + ':' + allowIntermediate;
    if (operands.has(key)) return operands.get(key);
    const result = [];
    const fn = word(functions, p);
    if (fn) {
      let q = p + fn.length;
      const used = new Set(), parts = [];
      let s;
      // A following group is the function argument, not an intermediate of
      // its last unwrapped script operand. Group that operand to override.
      while ((s = script(q, used, false))) { parts.push(...s.parts); q = s.end; }
      for (const input of inputsAt(q, bare, allowIntermediate))
        result.push({ end: input.end, ast: node('function', { name: fn, parts, arg: input.ast }) });
    }
    result.push(...inputsAt(p, bare, allowIntermediate));
    const reserved = word(symbols, p);
    if (bare && reserved && reserved.length > 1 && result[0] && result[0].end === p + 1) {
      operands.set(key, []); return [];
    }
    operands.set(key, result);
    return result;
  }
  // Preserve wrapping/intermediates first, but keep shorter endpoints so
  // A(B)C can fall back to A + '(' + B + ')' + C when A(B) leaves C adjacent.
  function inputsAt(p, bare, allowIntermediate) {
    const result = [];
    for (const literalParenthesis of [false, true]) {
      const start = p + (word(FIBERED_STYLES, p) || '').length;
      if (literalParenthesis && text[start] !== '(' && text[start] !== ')') continue;
      for (const intermediate of allowIntermediate ? [true, false] : [false]) {
        const item = inputAt(p, bare, intermediate, literalParenthesis);
        if (item && !result.some(old => old.end === item.end)) result.push(item);
      }
    }
    return result;
  }
  function inputAt(p, bare, allowIntermediate = true, literalParenthesis = false) {
    const style = word(FIBERED_STYLES, p);
    const b = base(p + (style ? style.length : 0), bare || scriptContext, literalParenthesis);
    if (!b) return null;
    const styled = style ? { end: b.end, ast: node('wrap', { name: style, inner: b.ast }) } : b;
    return decorate(styled, bare, allowIntermediate);
  }
  function symbol(p, withScripts = true) {
    if (spacing(p)) return null;
    const op = word(symbols, p) || (/[-+=:<>/,()]/.test(text[p] || '') ? text[p] : '');
    if (!op) return null;
    let q = p + op.length;
    const used = new Set(), parts = [];
    let s;
    while (withScripts && (s = script(q, used))) { parts.push(...s.parts); q = s.end; }
    const value = Object.prototype.hasOwnProperty.call(NONSTANDARD_SYMBOL_DICTIONARY, op)
      ? NONSTANDARD_SYMBOL_DICTIONARY[op] : /^[-+=:<>/,()]$/.test(op) ? (op === ':' ? ': ' : op) : '\\' + op;
    return { end: q, ast: node('symbol', { value, parts }) };
  }
  function sequence(p, previousOperand) {
    if (p === text.length) return [];
    const key = p + ':' + previousOperand;
    if (memo.has(key)) return memo.get(key);
    // Spacing preserves the operand/symbol state and never owns scripts.
    const space = spacing(p);
    if (space) {
      const tail = sequence(space.end, previousOperand);
      const result = tail && [space.ast].concat(tail);
      memo.set(key, result);
      return result;
    }
    const op = symbol(p);
    let choices;
    if (previousOperand) choices = (op ? [Object.assign({ isSymbol: true }, op)] : []).concat(relaxed ? operand(p) : []);
    else {
      const args = operand(p);
      const ops = (relaxed || p > 0) && op ? [Object.assign({ isSymbol: true }, op)] : [];
      // In a permissive group, a named operator beats splitting its name
      // into adjacent one-letter operands. A full function/Greek operand wins.
      const named = word(symbols, p);
      choices = relaxed && named && named.length > 1 && args[0] && args[0].end === p + 1
        ? ops.concat(args) : args.concat(ops);
    }
    for (const c of choices) {
      const tail = sequence(c.end, !c.isSymbol);
      if (tail) { const found = [c.ast].concat(tail); memo.set(key, found); return found; }
    }
    memo.set(key, null);
    return null;
  }
  if (!text || /\s/.test(text)) return null;
  const items = sequence(0, false);
  return items && node('sequence', { items });
}

function renderFiberedAst(ast, state = { tabIdx: 1 }) {
  const join = items => items.reduce((out, a) => {
    const value = renderFiberedAst(a, state);
    return out + (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(value) ? ' ' : '') + value;
  }, '');
  const scripts = parts => parts.map(p => p.kind + '{' + renderFiberedAst(p.ast, state) + '}').join('');
  switch (ast.type) {
    case 'quoted': return renderFiberedAst(ast.inner, state);
    case 'hole': return ' ${' + state.tabIdx++ + '}';
    case 'raw': case 'spacing': return ast.value;
    case 'symbol': return ast.value + scripts(ast.parts);
    case 'sequence': case 'concat': return join(ast.items);
    case 'wrap': return '\\' + ast.name + '{' + renderFiberedAst(ast.inner, state) + '}';
    case 'prime': return renderFiberedAst(ast.inner, state) + ast.value;
    case 'scripts': return renderFiberedAst(ast.inner, state) + scripts(ast.parts);
    case 'group': {
      const value = renderFiberedAst(ast.inner, state);
      if (ast.open === '{') return value;
      if (ast.open === '|') return '\\lvert ' + value + '\\rvert';
      const close = { '(': ')', '[': ']', '[[': ']]' }[ast.open];
      return ast.open + value + close;
    }
    case 'function': {
      const prefix = '\\' + ast.name + scripts(ast.parts);
      // Decorations preserve the delimiter choice of their underlying input.
      function explicitGroup(arg) {
        if (arg.type === 'group') return arg;
        if (arg.type === 'wrap' || arg.type === 'prime' || arg.type === 'scripts') return explicitGroup(arg.inner);
        if (arg.type === 'concat') return explicitGroup(arg.items.find(item => item.type !== 'spacing') || {});
        return null;
      }
      if (explicitGroup(ast.arg)) {
        const value = renderFiberedAst(ast.arg, state);
        return prefix + (/\\[A-Za-z]+$/.test(prefix) && /^[A-Za-z]/.test(value) ? ' ' : '') + value;
      }
      return prefix + '(' + renderFiberedAst(ast.arg, state) + ')';
    }
    default: throw new Error('Unknown fibered AST node');
  }
}

function parseFiberedChain(source, state) {
  if (shouldIgnoreFiberedInput(source)) return source;
  const ast = parseFiberedExpression(source);
  return ast ? renderFiberedAst(ast, state) : source;
}

function finishFiberedExpansion(value) {
  return value + (/\s$/.test(value) ? '' : ' ') + '$0';
}

function renderMultiFiberedText(m) {
  const ast = fiberedAstForMatch(m, 3);
  if (!ast) return preserveFiberedInput(m);
  const lead = m[2] || '';
  return finishFiberedExpansion((m[1] ? lead : lead + '\\$') + renderFiberedAst(ast) + '\\$' + (m[4] || ''));
}

function renderMultiFiberedMath(m) {
  if (!isFiberedBalancedWord(m, 1)) return preserveFiberedInput(m);
  let ast = fiberedAstForMatch(m, 1, 'math');
  let prefix = '';
  if (!ast) {
    // Prefer a whole expression; otherwise a source brace or parenthesis can mark
    // the start of a fresh expression within an existing TeX argument.
    for (let i = (m[1] || '').length - 1; i >= 0 && !ast; i--) {
      if (!'{}()'.includes(m[1][i])) continue;
      const inner = Array.from(m);
      inner[1] = m[1].slice(i + 1);
      inner.input = m.input;
      inner.index = Number.isInteger(m.index) ? m.index + i + 1 : undefined;
      ast = fiberedAstForMatch(inner, 1, 'math');
      if (ast) prefix = m[1].slice(0, i + 1);
    }
  }
  if (!ast) return preserveFiberedInput(m);
  return finishFiberedExpansion(prefix + renderFiberedAst(ast) + (m[2] || ''));
}
