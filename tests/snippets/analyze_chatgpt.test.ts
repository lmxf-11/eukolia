import { describe, it } from 'vitest';
import fs from 'node:fs';
import { validateSnippetFile, normalizeSnippetFile, loadEusnipsIntoEngine } from '../../src/renderer/snippets/eusnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';

describe('Inspect ChatGPT snippets.json at D:/Eukolia/User/snippets/snippets.json', () => {
  it('validates and compares ChatGPT snippets', () => {
    const chatGptPath = 'D:/Eukolia/User/snippets/snippets.json';
    const xplacePath = 'D:/XPlace/snippets.json';

    const chatGptRaw = fs.readFileSync(chatGptPath, 'utf8');
    const chatGptData = JSON.parse(chatGptRaw);

    console.log('=== 1. VALIDATION OF CHATGPT FILE ===');
    const validation = validateSnippetFile(chatGptData, { text: chatGptRaw });
    console.log('Valid:', validation.valid);
    console.log('Issue count:', validation.issues.length);
    if (validation.issues.length > 0) {
      console.log('Issues:', JSON.stringify(validation.issues.slice(0, 20), null, 2));
    }

    console.log('\n=== 2. COMPILATION & ENGINE CHECK ===');
    try {
      const normalized = normalizeSnippetFile(chatGptData);
      console.log('Normalized issue count:', normalized.issues.length);
      const engine = new SnippetEngine();
      const loaded = loadEusnipsIntoEngine(engine, [normalized]);
      console.log('Engine loaded successfully. Loaded snippets count:', loaded.length);
      console.log('Engine getSnippets(latex) count:', engine.getSnippets('latex').length);
    } catch (e: any) {
      console.error('Compilation or Engine Error:', e.message);
    }

    console.log('\n=== 3. WHAT SNIPPETS DID CHATGPT ACTUALLY CHANGE? ===');
    const xplaceData = JSON.parse(fs.readFileSync(xplacePath, 'utf8'));

    // Check which snippets in ChatGPT are merged or have regex/code
    const cgSnippets = chatGptData.snippets;
    const xpSnippets = xplaceData.snippets;

    // Check difference in triggers compared to original latex.hsnips
    // Let's read latex.hsnips
    const hsnipsRaw = fs.readFileSync('C:/Users/Yinji/AppData/Roaming/Code/User/hsnips/latex.hsnips', 'utf8');

    // Find all snippet IDs in ChatGPT
    const cgById = new Map(cgSnippets.map((s: any) => [s.id, s]));
    const xpById = new Map(xpSnippets.map((s: any) => [s.id, s]));

    // Find snippets in ChatGPT that have code in body (rv = ...)
    const cgWithCode = cgSnippets.filter((s: any) => {
      const body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
      return body.includes('rv =') || body.includes('``');
    });
    console.log('ChatGPT snippets with code in body:', cgWithCode.length);

    // List largest code snippets in ChatGPT and XPlace
    const codeSizes = cgWithCode.map((s: any) => {
      const body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
      return {
        id: s.id,
        trigger: s.trigger?.pattern || s.trigger,
        desc: s.description,
        length: body.length,
        lines: body.split('\n').length,
        bodyPreview: body.slice(0, 120).replace(/\n/g, ' ')
      };
    }).sort((a: any, b: any) => b.length - a.length);

    console.log('\nTop 15 Largest Code Snippets in ChatGPT:');
    for (const c of codeSizes.slice(0, 15)) {
      console.log(`- [${c.id}] trigger="${c.trigger}" (${c.length} chars, ${c.lines} lines) desc: "${c.desc}"`);
      console.log(`    preview: ${c.bodyPreview}`);
    }

    console.log('\n=== 8. TEST EQUIVALENCE OF REFACTORED GLOBAL HELPERS ===');

    // Test 1: renderTernaryEquation vs zasfps / 6w3xff original code
    function origZasfps(m: any[]) {
      let out = "";
      if (!m[1]) { out += " " + "\\$"; } else { out += (m[2] || ""); }
      let hold = "";
      if (m[3]) { hold += "\\" + m[3] + "{" + (m[4] || "") + "}"; } else { hold += m[4]; }
      if (m[6]) { hold = "\\" + m[6] + "{" + (hold || "") + "}"; }
      out += hold + " = ";
      let hold1 = "";
      if (m[7]) { hold1 += "\\" + m[7] + "{" + (m[8] || "") + "}"; } else { hold1 += m[8]; }
      if (m[10]) { hold1 = "\\" + m[10] + "{" + (hold1 || "") + "}"; }
      out += hold1 + " " + (m[11] || "") + " ";
      let hold2 = "";
      if (m[12]) { hold2 += "\\" + m[12] + "{" + (m[13] || "") + "}"; } else { hold2 += (m[13] || ""); }
      if (m[15]) { hold2 = "\\" + m[15] + "{" + (hold2 || "") + "}"; }
      out += hold2;
      return out + "$" + (m[16] || "");
    }

    function renderDecoratedAtom(style: string, atom: string, accent: string, prefix = "") {
      let value = prefix;
      value += style ? "\\" + style + "{" + (atom || "") + "}" : (atom || "");
      return accent ? "\\" + accent + "{" + value + "}" : value;
    }

    function newRenderTernaryEquation(m: any[], tightOp = false) {
      let out = !m[1] ? " \\$" : (m[2] || "");
      let left = renderDecoratedAtom(m[3], m[4], m[6]);
      let mid = renderDecoratedAtom(m[7], m[8], m[10]);
      let right = renderDecoratedAtom(m[12], m[13], m[15]);
      let op = m[11] || "";
      let opStr = tightOp ? op : " " + op + " ";
      return out + left + " = " + mid + opStr + right + "$" + (m[16] || "");
    }

    // Test with sample match
    const sampleMatch = [
      "", // 0 full match
      "", // 1 $
      " ", // 2 delim
      "bf", // 3 style1
      "x", // 4 atom1
      "", // 5 prime
      "bar", // 6 accent1
      "", // 7 style2
      "y", // 8 atom2
      "", // 9
      "hat", // 10 accent2
      "+", // 11 op
      "cal", // 12 style3
      "Z", // 13 atom3
      "", // 14
      "", // 15 accent3
      " " // 16 trailing
    ];

    const origRes = origZasfps(sampleMatch);
    const newRes = newRenderTernaryEquation(sampleMatch, false);
    console.log('Zasfps Orig:', origRes);
    console.log('Zasfps New: ', newRes);
    console.log('Zasfps Equivalent:', origRes === newRes);

    // Test 2: Multi-integral
    function origMultiIntegral(m: any[]) {
      let final = "\\";
      let isO = m[1] == "o";
      (isO) ? final += "o" : "";
      let b = 1;
      let isL = m[2] == "l";
      (m[3] == 'd') ? b = 2 : (m[3] == 't') ? b = 3 : 1;
      for (let i = 0; i < b - 1; i++) { final += "i"; }
      final += "int";
      final += ((b >= 2) || (b != 1 && !isO && isL)) ? "\\limits" : "";
      let r = (b == 3) ? "E" : (b == 1 && (isL || isO)) ? "C" : "R";
      final += ((b >= 2) || isO || (b == 1 && isL)) ? "_{${1:" + r + "}}" : "_{${1:-\\oo}}^{${2:\\oo}}";
      let x = (b == 2) ? "A" : (b == 3) ? "V" : (b == 1 && isL) ? "s" : "x";
      final += " ${3} \\mathrm{d}${4:" + x + "}$0";
      return final;
    }

    const intCases = [
      ['cint', undefined, undefined, undefined],
      ['coint', 'o', undefined, undefined],
      ['clint', undefined, 'l', undefined],
      ['cldint', undefined, 'l', 'd'],
      ['cntint', undefined, 'n', 't']
    ];
    let allIntsPass = true;
    for (const c of intCases) {
      const o = origMultiIntegral(c);
      // test with new
      let isO = c[1] == "o";
      let isL = c[2] == "l";
      let b = (c[3] == 'd') ? 2 : (c[3] == 't') ? 3 : 1;
      let final = "\\" + (isO ? "o" : "") + "i".repeat(b - 1) + "int";
      if ((b >= 2) || (b != 1 && !isO && isL)) final += "\\limits";
      let r = (b == 3) ? "E" : (b == 1 && (isL || isO)) ? "C" : "R";
      final += ((b >= 2) || isO || (b == 1 && isL)) ? "_{${1:" + r + "}}" : "_{${1:-\\oo}}^{${2:\\oo}}";
      let x = (b == 2) ? "A" : (b == 3) ? "V" : (b == 1 && isL) ? "s" : "x";
      final += " ${3} \\mathrm{d}${4:" + x + "}$0";
      if (o !== final) {
        console.error('Mismatch in integral:', c, 'orig:', o, 'new:', final);
        allIntsPass = false;
      }
    }
    console.log('\n=== 9. ALL SNIPPETS IN XPLACE WITH BODY LENGTH > 100 CHARS ===');
    const xpLongSnippets = xpSnippets.filter((s: any) => {
      const b = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
      return b.length > 100;
    }).sort((a: any, b: any) => {
      const bA = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
      const bB = typeof b.body === 'string' ? b.body : JSON.stringify(b.body);
      return bB.length - bA.length;
    });

    console.log(`Found ${xpLongSnippets.length} snippets in XPlace with body length > 100 chars:`);
    for (const s of xpLongSnippets) {
      const b = typeof s.body === 'string' ? s.body : JSON.stringify(s.body);
      const hasCode = b.includes('rv =') || b.includes('``');
      console.log(`- [${s.id}] trigger="${s.trigger?.pattern || s.trigger}" (${b.length} chars, hasCode=${hasCode}) desc: "${s.description}"`);
    }
  });
});
