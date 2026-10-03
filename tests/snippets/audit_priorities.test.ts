import { describe, it } from 'vitest';
import fs from 'fs';

describe('Audit Priorities in latex.hsnips', () => {
  it('checks priorities of merged snippet groups', () => {
    const hsnips = fs.readFileSync('C:/Users/Yinji/AppData/Roaming/Code/User/hsnips/latex.hsnips', 'utf8');
    const lines = hsnips.split(/\r?\n/);
    let curPriority = 0;
    const snips: Array<{ line: number; trigger: string; priority: number; flags: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('priority ')) {
        curPriority = parseInt(line.slice('priority '.length).trim(), 10);
      } else if (line.startsWith('snippet')) {
        const match = line.match(/^snippet ?(?:`([^`]+)`|(\S+))?(?: "((?:[^"\\]|\\.)*)")?(?: ([AMiwbmhn]*))?/);
        const trigger = match ? (match[1] ?? match[2] ?? '') : '';
        const flags = match ? (match[4] || '') : '';
        snips.push({ line: i + 1, trigger, priority: curPriority || 100, flags });
        curPriority = 0;
      }
    }

    console.log(`Total parsed snippets: ${snips.length}`);

    // 1. Greek Math
    const greekMathTriggers = [
      '@a', '@b', '@g', '@G', '@d', '@D', '@e', '@ve', '@z', '@th', '@vt', '@vth',
      '@Th', '@i', '@k', '@l', '@L', '@m', '@n', '@x', '@X', '@pi', '@Pi', '@vpi',
      '@r', '@vr', '@s', '@S', '@vs', '@ta', '@u', '@U', '@ph', '@vph', '@Ph',
      '@ch', '@ps', '@Ps', '@o', '@O'
    ];
    const greekMath = snips.filter(s => s.flags.includes('m') && greekMathTriggers.includes(s.trigger));
    console.log('Greek Math priorities:', Array.from(new Set(greekMath.map(s => s.priority))));
    greekMath.filter(s => s.priority !== 100).forEach(s => console.log(`  Greek Math anomaly: [Line ${s.line}] ${s.trigger} priority=${s.priority}`));

    // 2. Greek Text
    const greekTextTriggers = greekMathTriggers.map(t => ' ' + t);
    const greekText = snips.filter(s => greekTextTriggers.includes(s.trigger));
    console.log('Greek Text priorities:', Array.from(new Set(greekText.map(s => s.priority))));
    greekText.filter(s => s.priority !== 1000).forEach(s => console.log(`  Greek Text anomaly: [Line ${s.line}] ${s.trigger} priority=${s.priority}`));

    // 3. Categories
    const catTriggers = [
      'Set ', 'Set\\*', 'Grp ', 'Ab ', 'Vect ', 'Vec ', 'Matr ', 'Top ', 'Toph ', 'Toph\\*',
      'Top\\*', 'Ring ', 'CRing ', 'CAlg ', 'Alg ', 'Rng ', 'Mod ', 'SMod ', 'Mon ', 'CMon ',
      'Poset ', 'Graph ', 'CW ', 'hCW ', 'Diff ', 'Man ', 'Met ', 'Hilb ', 'Ban ', 'Field ',
      'FinSet ', 'Rel ', 'Cat ', 'CAT ', 'Ord ', 'Simp ', 'Sp ', 'Ens ', 'Pos ', 'PreO ',
      'Hask ', 'Cob ', 'FinS ', 'FinV ', 'Meas ', 'Sch ', 'Bimod ', 'Haus ', 'CompH ',
      'PL ', 'Lat ', 'B \\\\oo l ', 'Heyt ', 'Type ', 'Asm ', 'AffSch ', 'Aff ', 'Var ',
      'SmVar ', 'AffVar ', 'ProjVar '
    ];
    const catSnips = snips.filter(s => s.flags.includes('m') && catTriggers.some(t => s.trigger === t || s.trigger === t.replace(/\\\\/g, '\\')));
    console.log('Categories math priorities:', Array.from(new Set(catSnips.map(s => s.priority))));
    catSnips.filter(s => s.priority !== 100).forEach(s => console.log(`  Category anomaly: [Line ${s.line}] "${s.trigger}" priority=${s.priority}`));

    // 4. Alignment
    const alignTriggers = [';=', ';<', ';>', ';g', ';l', ';n', ';+', ';-'];
    const alignSnips = snips.filter(s => alignTriggers.includes(s.trigger));
    console.log('Alignment priorities:', Array.from(new Set(alignSnips.map(s => s.priority))));

    // 5. Operator Spacing
    const spacingTriggers = ['(.)\\+', '(.)\\-', '(.)\\<', '(.)\\>', '(.)\\=', '(.)\\~', '(.):'];
    const spacingSnips = snips.filter(s => spacingTriggers.includes(s.trigger));
    console.log('Operator spacing priorities:', Array.from(new Set(spacingSnips.map(s => s.priority))));

    // 6. Double Letter Subscripts
    const subDoubleTriggers = ['aa', 'ii', 'jj', 'kk', 'mm', 'nn', 'pp', 'qq', 'rr', 'ss', 'tt', 'uu', 'vv', 'xx', 'yy', 'zz'];
    const subDoubleSnips = snips.filter(s => s.flags.includes('m') && subDoubleTriggers.includes(s.trigger));
    console.log('Double letter subscripts priorities:', Array.from(new Set(subDoubleSnips.map(s => s.priority))));

    // 7. Derivatives
    const pdMath = snips.filter(s => ['pd1', 'pd2', 'pd3', 'pdn'].includes(s.trigger));
    console.log('pd math priorities:', pdMath.map(s => `${s.trigger}: ${s.priority}`));
    const ddMath = snips.filter(s => ['dd1', 'dd2', 'dd3', 'ddn'].includes(s.trigger));
    console.log('dd math priorities:', ddMath.map(s => `${s.trigger}: ${s.priority}`));

    const pdText = snips.filter(s => s.trigger.includes('pd1') || s.trigger.includes('pd2') || s.trigger.includes('pd3') || s.trigger.includes('pdn'));
    console.log('pd text priorities:', pdText.map(s => `${s.trigger}: ${s.priority}`));
    const ddText = snips.filter(s => s.trigger.includes('dd1') || s.trigger.includes('dd2') || s.trigger.includes('dd3') || s.trigger.includes('ddn'));
    console.log('dd text priorities:', ddText.map(s => `${s.trigger}: ${s.priority}`));

    // 8. Integrals
    const intMath = snips.filter(s => ['int', '2int', '3int', 'oint'].includes(s.trigger) && s.flags.includes('m'));
    console.log('Integrals math priorities:', intMath.map(s => `${s.trigger}: ${s.priority}`));

    // 9. Brackets
    const bracketMath = snips.filter(s => ['a"', 'n"', 's"', 'p"', 'b"', 'g"'].includes(s.trigger));
    console.log('Brackets math priorities:', bracketMath.map(s => `${s.trigger}: ${s.priority}`));

    // 10. Space vs Comma auto-inline pairs
    const spaceAuto = snips.filter(s => s.trigger.startsWith('(\\$)?(?<!\\.)(\\s+)'));
    const commaAuto = snips.filter(s => s.trigger.startsWith('(\\$)?(?<!\\.)(\\s*),'));
    console.log(`Space auto count: ${spaceAuto.length}, Comma auto count: ${commaAuto.length}`);

    // Check priority mismatches between space and comma pairs
    const spaceBySuffix = new Map<string, number>();
    for (const s of spaceAuto) {
      spaceBySuffix.set(s.trigger.slice('(\\$)?(?<!\\.)(\\s+)'.length), s.priority);
    }
    const priorityMismatches: string[] = [];
    for (const c of commaAuto) {
      const suffix = c.trigger.slice('(\\$)?(?<!\\.)(\\s*),'.length);
      if (spaceBySuffix.has(suffix)) {
        const spacePri = spaceBySuffix.get(suffix)!;
        if (spacePri !== c.priority) {
          priorityMismatches.push(`Suffix "${suffix}": space priority=${spacePri} vs comma priority=${c.priority}`);
        }
      }
    }
    console.log('Priority mismatches in auto-inline pairs:', priorityMismatches.length);
    priorityMismatches.forEach(m => console.log('  ' + m));
  });

  it('compares all snippets in D:/XPlace/snippets.json with latex.hsnips', () => {
    const hsnips = fs.readFileSync('C:/Users/Yinji/AppData/Roaming/Code/User/hsnips/latex.hsnips', 'utf8');
    const xplace = JSON.parse(fs.readFileSync('D:/XPlace/snippets.json', 'utf8'));

    const lines = hsnips.split(/\r?\n/);
    let curPriority = 0;
    const origSnips: Array<{ line: number; trigger: string; priority: number; flags: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('priority ')) {
        curPriority = parseInt(line.slice('priority '.length).trim(), 10);
      } else if (line.startsWith('snippet')) {
        const match = line.match(/^snippet ?(?:`([^`]+)`|(\S+))?(?: "((?:[^"\\]|\\.)*)")?(?: ([AMiwbmhn]*))?/);
        const trigger = match ? (match[1] ?? match[2] ?? '') : '';
        const flags = match ? (match[4] || '') : '';
        origSnips.push({ line: i + 1, trigger, priority: curPriority || 100, flags });
        curPriority = 0;
      }
    }

    const specialIds = new Set([
      'greek_math', 'greek_text', 'categories_math', 'align_ops', 'spacing_ops',
      'sub_doubles', 'pd_math', 'pd_text', 'dd_math', 'dd_text',
      'integrals_math', 'integrals_text', 'brackets_math', 'brackets_text',
      'font_manual', 'font_symbol', 'font_cal_scr', 'font_postfix'
    ]);

    let mismatchCount = 0;
    for (const s of xplace.snippets) {
      if (specialIds.has(s.id)) continue;

      if (s.trigger.pattern.startsWith('(\\$)?(?<!\\.)(\\s*,|\\s+)')) {
        const suffix = s.trigger.pattern.slice('(\\$)?(?<!\\.)(\\s*,|\\s+)'.length);
        const spacePat = '(\\$)?(?<!\\.)(\\s+)' + suffix;
        const commaPat = '(\\$)?(?<!\\.)(\\s*),' + suffix;
        const spacePri = origSnips.find(o => o.trigger === spacePat)?.priority;
        const commaPri = origSnips.find(o => o.trigger === commaPat)?.priority;
        const maxPri = Math.max(spacePri ?? 0, commaPri ?? 0);
        const actualPri = s.priority || 100;
        if (actualPri < maxPri) {
          console.log(`Auto-inline priority degraded: ${s.id} (actual: ${actualPri}, origMax: ${maxPri}) suffix: ${suffix.slice(0, 40)}`);
          mismatchCount++;
        }
      } else {
        const orig = origSnips.find(o => o.trigger === s.trigger.pattern);
        if (orig) {
          const origPri = orig.priority;
          const actualPri = s.priority || 100;
          if (origPri !== actualPri) {
            console.log(`Regular snippet mismatch: [${s.id}] pattern "${s.trigger.pattern}" actual=${actualPri} orig=${origPri}`);
            mismatchCount++;
          }
        }
      }
    }
    console.log(`Total non-merged/auto mismatches: ${mismatchCount}`);
  });
});
