/**
 * Eukolia — reading a snippet's problems back to the person who has to fix them.
 *
 * Validation answers "is this document legal?" and says so in the vocabulary of
 * the schema: `/snippets/3/trigger`, `must be integer`. That is the right answer
 * for a validator and the wrong one for an editor, which has to put the sentence
 * *under the field that is wrong* and say what to do about it.
 *
 * This module is that translation, and it is deliberately pure: no React, no
 * store, no DOM. Everything the Snippets editor shows about a problem — the
 * warning triangle's list, the sentence under a field, which control a problem
 * belongs to — comes from here, so the editor cannot show one thing in the list
 * and another in the form.
 *
 * A problem has two halves and they come from different places:
 *
 *  * **where it is** — the JSON pointer, which the validator produces and which
 *    names the offending *property*;
 *  * **what it means** — the schema issue's own message, or, for the semantic
 *    pass, the message `normalizeSnippetFile` wrote.
 *
 * The second is rewritten where the format's own words are not what a person
 * would say. `must be one of: "manual", "auto"` is a correct description of the
 * problem and a poor thing to read at the moment you are trying to fix it, so it
 * becomes "The expansion mode has to be manual or auto."
 */

import type { EusnipsFile, EusnipsIssue, EusnipsSnippet } from './model';
import type { ValidationIssue } from './validate';

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Every part of a snippet the editor can put a problem against.
 *
 * The set is the schema's own properties, grouped the way the editor is: the
 * four that decide whether a snippet *works* (what it matches, where, what it
 * inserts), and the rest.
 */
export type SnippetField =
  | 'id'
  | 'trigger'
  | 'flags'
  | 'description'
  | 'boundary'
  | 'expand'
  | 'priority'
  | 'context'
  | 'multiline'
  | 'options'
  | 'hidden'
  | 'enabled'
  | 'tags'
  | 'script'
  | 'metadata'
  | 'body';

/** How a field is named in a tooltip, where there is no label next to it. */
export const FIELD_LABELS: Record<SnippetField, string> = {
  id: 'Id',
  trigger: 'Trigger',
  flags: 'Flags',
  description: 'Description',
  boundary: 'Boundary',
  expand: 'Expansion',
  priority: 'Priority',
  context: 'Context',
  multiline: 'Multi-line',
  options: 'Extra flags',
  hidden: 'Hidden',
  enabled: 'Enabled',
  tags: 'Tags',
  script: 'Script',
  metadata: 'Stored data',
  body: 'Body'
};

/**
 * Which field each schema property belongs to.
 *
 * A property is not always the field's own name: the trigger's text is `pattern`
 * in the file and the trigger in the editor, and `nested` properties
 * (`context.name`) are reached by the same table because the lookup takes the
 * property that follows `/snippets/<n>/`.
 */
const FIELD_BY_PROPERTY: Record<string, SnippetField> = {
  id: 'id',
  trigger: 'trigger',
  description: 'description',
  priority: 'priority',
  expand: 'expand',
  boundary: 'boundary',
  hidden: 'hidden',
  multiline: 'multiline',
  options: 'options',
  context: 'context',
  body: 'body',
  tags: 'tags',
  enabled: 'enabled',
  script: 'script',
  metadata: 'metadata',
  // The properties inside the trigger belong to the trigger: it is one property
  // holding one answer, drawn by one control, and a complaint about its text is
  // a complaint about the box that text is typed into.
  pattern: 'trigger',
  flags: 'flags',
  value: 'trigger',
  caseSensitive: 'trigger',
  type: 'trigger'
};

/** The snippet index a JSON pointer names, or `null` for a file-level problem. */
export function snippetIndexOfPointer(path: string): number | null {
  const match = /^\/snippets\/(\d+)/.exec(path);
  return match ? Number(match[1]) : null;
}

/** The property a JSON pointer names, e.g. `trigger` for `/snippets/3/trigger/value`. */
export function propertyOfPointer(path: string): string {
  return path.split('/')[3] ?? '';
}

/**
 * The field a schema pointer belongs to.
 *
 * Falls back to `body` rather than to `trigger`: a pointer the table does not
 * know is one deeper inside a value than the editor models, and the body is the
 * one field that holds free-form text where that is expected.
 */
export function fieldOfPointer(path: string): SnippetField {
  return FIELD_BY_PROPERTY[propertyOfPointer(path)] ?? 'body';
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export interface SnippetProblem {
  /** The control that has to change. */
  field: SnippetField;
  /** One sentence, written for the person reading it. */
  message: string;
  level: 'error' | 'warning';
}

/**
 * True when a problem is the one an empty trigger produces.
 *
 * Both spellings are recognised: the schema's branch complaint, which arrives
 * first and says only that something is too short, and the format's own sentence,
 * which arrives afterwards and explains it. Collapsing them is what keeps one
 * line in the tooltip for one mistake.
 */
export function isEmptyTriggerProblem(problem: SnippetProblem): boolean {
  if (problem.field !== 'trigger') return false;
  return (
    problem.message.startsWith('The trigger is empty') ||
    problem.message.startsWith('the trigger is empty')
  );
}

/**
 * The schema's own wording. A complaint this list has nothing to add to is kept
 * as the schema wrote it: a message nobody anticipated is still better than none.
 */
const KEEP = Symbol('keep');

/**
 * Rewrites one of the schema's messages into something a person can act on.
 *
 * Only the cases where the schema's sentence is not the useful one are listed.
 * The message is the *last* fragment of a path — the schema says `must not be
 * empty` about a trigger's value — so the rewrite supplies the subject from the
 * field, which is the one thing the fragment cannot know.
 */
function rewrite(message: string, field: SnippetField): string | typeof KEEP {
  const oneOf = /^must be one of: (.*)$/.exec(message);
  const pattern = /^must match (\S+)$/.exec(message);
  const atLeast = /^must be at least (\S+)$/.exec(message);
  const atMost = /^must be at most (\S+)$/.exec(message);

  if (/must not be empty/.test(message)) {
    switch (field) {
      case 'trigger':
        return 'The trigger is empty, so this snippet can never match anything. Type the text that should expand it.';
      case 'id':
        return 'The id is empty. Use Generate, or type a name that is unique in this file.';
      case 'metadata':
        return 'A stored value is empty, which the format does not allow. Remove it or give it a value.';
      default:
        return 'This has to have a value.';
    }
  }

  if (/must be integer/.test(message)) return 'This has to be a whole number.';
  if (/is a duplicate/.test(message)) return 'This is a duplicate of another entry in the same list.';
  if (oneOf) {
    const values = oneOf[1].split(', ').map((value) => value.replace(/^"|"$/g, ''));
    return `This has to be one of: ${values.join(', ')}.`;
  }
  if (pattern) return `This has to match the pattern ${pattern[1]}.`;
  if (atLeast) return `This has to be ${atLeast[1]} or more.`;
  if (atMost) return `This has to be ${atMost[1]} or less.`;

  return KEEP;
}

/**
 * The problems a schema issue describes, attributed to fields.
 *
 * A `oneOf` failure produces one issue per branch, and the branches are
 * discriminated — the trigger is a string *or* one of two objects — so an empty
 * trigger arrives as up to three complaints about the same mistake. `dedupe`
 * collapses them and keeps the most explanatory, which is the format's own
 * sentence rather than the schema's fragment of one.
 */
export function describeValidationIssues(
  issues: readonly ValidationIssue[],
  index: number
): SnippetProblem[] {
  const problems: SnippetProblem[] = [];
  for (const issue of issues) {
    if (snippetIndexOfPointer(issue.path) !== index) continue;
    const field = fieldOfPointer(issue.path);
    const message = rewrite(issue.message, field);
    problems.push({ field, message: message === KEEP ? issue.message : message, level: 'error' });
  }
  return dedupe(problems);
}

/**
 * The problems `normalizeSnippetFile` reported for one entry.
 *
 * These are the format's own warnings — a feature that will not behave as
 * written — and each one is written for a person already, so it is kept exactly
 * as it is and only *attributed* to a field. Rewriting it here would be inventing
 * a second copy of a sentence the format already got right.
 */
export function describeSemanticIssues(
  issues: readonly EusnipsIssue[],
  index: number
): SnippetProblem[] {
  const problems: SnippetProblem[] = [];
  for (const issue of issues) {
    if (issue.index !== index) continue;
    problems.push({ field: fieldOfMessage(issue.message), message: issue.message, level: issue.level });
  }
  return dedupe(problems);
}

/**
 * Which field a semantic warning is about.
 *
 * `normalizeSnippetFile` writes prose, not pointers, so the message a snippet
 * carries is paired with the field it concerns in one table. It used to be
 * guessed from keywords, which is how `"multiline" only applies to a regular
 * expression trigger` ended up filed under the trigger: the message names both,
 * and only one of them is what the reader has to change.
 *
 * A message the table does not know goes to the description, which is the field
 * that describes the snippet as a whole — anywhere else would send the reader to
 * the wrong end of the form.
 */
const FIELD_BY_MESSAGE: Array<[string, SnippetField]> = [
  ['"multiline": ', 'multiline'],
  ['"multiline" only applies', 'multiline'],
  ['asks for that many previous lines', 'multiline'],
  ['"boundary" is ignored', 'boundary'],
  ['the context ', 'context'],
  ['"script" is stored', 'script'],
  ['the body carries', 'body'],
  ['a text body node may not contain a backtick', 'body'],
  ['the trigger contains a backtick', 'trigger'],
  ['the trigger contains a line break', 'trigger'],
  ['the trigger is empty', 'trigger'],
  ['the "g" and "y" flags are stateful', 'trigger'],
  ['the regular expression does not compile', 'trigger'],
  ['is already used by snippet', 'id'],
  ['the "id" ', 'id']
];

export function fieldOfMessage(message: string): SnippetField {
  for (const [prefix, field] of FIELD_BY_MESSAGE) {
    if (message.startsWith(prefix)) return field;
  }
  return 'description';
}

/** The same complaint twice is one problem, not two. */
function dedupe(problems: readonly SnippetProblem[]): SnippetProblem[] {
  const result: SnippetProblem[] = [];
  const at = new Map<string, number>();
  for (const problem of problems) {
    // The empty-trigger complaint is the one that arrives repeatedly, and its
    // forms differ in wording — the schema's branch complaints and the format's
    // own sentence — so the *kind* is part of the key rather than the sentence.
    const kind = isEmptyTriggerProblem(problem) ? 'empty' : problem.message;
    const key = `${problem.field}|${problem.level}|${kind}`;
    const existing = at.get(key);
    if (existing === undefined) {
      // A complaint with no sentence of its own is not worth keeping; the same
      // mistake arrives again below with one.
      if (problem.message === '') continue;
      at.set(key, result.length);
      result.push(problem);
      continue;
    }
    // Replace a placeholder sentence with the explanatory one.
    if (result[existing].message === '') result[existing] = problem;
  }
  return result;
}

/**
 * Everything wrong with one entry, in the order the form reads.
 *
 * Both passes are merged here so a caller never has to know that a problem can
 * come from two places — which is what stops the list and the form disagreeing
 * about whether an entry has a problem at all.
 */
export function snippetProblems(
  file: EusnipsFile,
  index: number,
  validationIssues: readonly ValidationIssue[],
  issues: readonly EusnipsIssue[]
): SnippetProblem[] {
  if (index < 0 || index >= (file.snippets?.length ?? 0)) return [];
  return [
    ...describeValidationIssues(validationIssues, index),
    ...describeSemanticIssues(issues, index)
  ];
}

/** One line per problem, for a tooltip. */
export function problemLines(problems: readonly SnippetProblem[]): string[] {
  return problems.map((problem) => `${FIELD_LABELS[problem.field]}: ${problem.message}`);
}

/** A tooltip's text: what is wrong, and whose it is when it is not obvious. */
export function problemTooltip(snippet: EusnipsSnippet | undefined, problems: readonly SnippetProblem[]): string {
  if (problems.length === 0) return '';
  const who = snippet?.description || snippet?.id || 'This snippet';
  const heading = `${who} — ${problems.length} problem${problems.length === 1 ? '' : 's'}`;
  return [heading, ...problemLines(problems).map((line) => `• ${line}`)].join('\n');
}

/** How many problems each entry has, for the list's markers and the filter. */
export function indexProblemCounts(
  validationIssues: readonly ValidationIssue[],
  issues: readonly EusnipsIssue[]
): Map<number, number> {
  const counts = new Map<number, number>();
  const bump = (index: number | null) => {
    if (index === null) return;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  };
  for (const issue of validationIssues) bump(snippetIndexOfPointer(issue.path));
  for (const issue of issues) bump(issue.index);
  return counts;
}

/**
 * The schema's version of a snippet, for the Advanced editor's raw view.
 *
 * The document as the file holds it, with the properties the editor generates
 * left in: this is what "the complete schema" means to a reader who wants to see
 * the entry rather than the controls.
 */
export function snippetAsStored(snippet: EusnipsSnippet): string {
  return `${JSON.stringify(snippet, null, 2)}\n`;
}
