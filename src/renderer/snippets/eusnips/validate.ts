/**
 * Eukolia — EUSnips schema validation.
 *
 * The snippet file format is described by a real JSON Schema (`./schema.json`,
 * draft 2020-12) and this module is what makes the schema the *contract* rather
 * than a comment: nothing is written to `snippets.json` until it validates, and
 * a hand-edited file that does not is reported with the exact path that failed
 * instead of being silently repaired or discarded.
 *
 * Rather than pulling in a general-purpose validator, the keyword handling below
 * is restricted to the keywords the EUSnips schema actually uses. That is a
 * deliberate trade: the surface is small enough to read in one sitting, its
 * behaviour is pinned by `tests/snippets/eusnips.test.ts`, and the schema keeps
 * being a single, ordinary JSON file instead of a DSL that has to be compiled.
 *
 * Two things are deliberately *not* implemented, because the schema does not use
 * them: remote `$ref` resolution (only local JSON pointers, so validation can
 * never touch the network) and `format` assertions.
 */

import rawSchema from './schema.json';
import {
  offsetsOfJsonPointers,
  positionOfOffset,
  type JsonPosition
} from './jsonSource';

/** The EUSnips schema, as loaded from disk. */
export const EUSNIPS_SCHEMA: Record<string, unknown> = rawSchema as Record<string, unknown>;

/** Keywords this validator understands. Anything else in a schema is ignored. */
interface SchemaNode {
  $ref?: string;
  $comment?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
  not?: SchemaNode;
  default?: unknown;
  description?: string;
}

export interface ValidationIssue {
  /**
   * JSON pointer to the offending value, with `~0`/`~1` escaping resolved, e.g.
   * `/snippets/3/trigger/value`. `''` means the document itself.
   */
  path: string;
  /** Human-readable reason, written for the snippets editor. */
  message: string;
  /** Where the value sits in the file's own text, when it could be located. */
  position?: JsonPosition;
}

export interface ValidationResult {
  /** True when {@link issues} is empty. */
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  /**
   * File text the document was parsed from. When supplied, every issue also
   * carries the line and column of the offending value, which is what lets the
   * editor point at the entry a hand-edit broke.
   */
  text?: string;
}

function pointerEscape(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerJoin(base: string, segment: string | number): string {
  return `${base}/${pointerEscape(String(segment))}`;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '#') return root;
  const trimmed = pointer.replace(/^#/, '');
  if (!trimmed.startsWith('/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of trimmed.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      const index = Number(segment);
      node = Number.isInteger(index) ? node[index] : undefined;
    } else if (node && typeof node === 'object') {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Where each `$ref` in the schema finally points.
 *
 * The schema is one module-level object and never changes, so a reference is
 * resolved once and remembered against the node that carries it. Resolving them
 * by walking the document schema again — once per reference, per entry, per
 * keystroke — was a measurable part of validating a large library, and the walk
 * answers the same thing every time.
 *
 * Only successes are cached: an unresolvable reference reports itself through the
 * validator's own issue list, and it has to keep doing so on every run.
 */
const REF_CACHE = new WeakMap<SchemaNode, SchemaNode>();

/**
 * Compiled schema patterns, keyed by their source.
 *
 * A pattern is a fixed string from the schema and is asked about thousands of
 * times in one validation; compiling it each time was the other measurable cost.
 * A `RegExp` this schema produces carries no flags — the schema writes its
 * patterns without them — so there is no `lastIndex` to make sharing unsafe.
 */
const PATTERN_CACHE = new Map<string, RegExp>();

function patternFor(source: string): RegExp {
  const cached = PATTERN_CACHE.get(source);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(source);
  PATTERN_CACHE.set(source, compiled);
  return compiled;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return true;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

class Validator {
  private readonly issues: ValidationIssue[] = [];
  /** Guards against a pathological `$ref` cycle; the EUSnips schema has none. */
  private depth = 0;

  constructor(private readonly schema: SchemaNode) {}

  run(document: unknown): ValidationIssue[] {
    this.check(this.schema, document, '');
    return this.issues;
  }

  private fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  private deref(node: SchemaNode): SchemaNode {
    if (!node.$ref) return node;
    const cached = REF_CACHE.get(node);
    if (cached !== undefined) return cached;
    const resolved = resolvePointer(this.schema, node.$ref);
    if (!resolved || typeof resolved !== 'object') {
      this.fail('', `the schema's own ${node.$ref} could not be resolved`);
      return {};
    }
    const target = resolved as SchemaNode;
    REF_CACHE.set(node, target);
    return target;
  }

  private check(node: SchemaNode, value: unknown, path: string): void {
    if (this.depth > 200) return;
    this.depth += 1;
    try {
      this.checkNode(node, value, path);
    } finally {
      this.depth -= 1;
    }
  }

  private checkNode(node: SchemaNode, value: unknown, path: string): void {
    if (node.$ref) {
      this.check(this.deref(node), value, path);
      return;
    }

    if (node.type !== undefined) {
      const expected = Array.isArray(node.type) ? node.type : [node.type];
      if (!expected.some((candidate) => matchesType(value, candidate))) {
        this.fail(path, `must be ${expected.join(' or ')}`);
        return;
      }
    }

    if (node.const !== undefined && !sameValue(value, node.const)) {
      this.fail(path, `must be ${JSON.stringify(node.const)}`);
    }

    if (node.enum && !node.enum.some((candidate) => sameValue(value, candidate))) {
      this.fail(path, `must be one of: ${node.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
    }

    if (typeof value === 'string') {
      if (node.minLength !== undefined && value.length < node.minLength) {
        this.fail(path, node.minLength === 1 ? 'must not be empty' : `must be at least ${node.minLength} characters`);
      }
      if (node.maxLength !== undefined && value.length > node.maxLength) {
        this.fail(path, `must be at most ${node.maxLength} characters`);
      }
      if (node.pattern !== undefined && !patternFor(node.pattern).test(value)) {
        this.fail(path, `must match ${node.pattern}`);
      }
    }

    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) this.fail(path, `must be at least ${node.minimum}`);
      if (node.maximum !== undefined && value > node.maximum) this.fail(path, `must be at most ${node.maximum}`);
    }

    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) {
        this.fail(path, `must hold at least ${node.minItems} entr${node.minItems === 1 ? 'y' : 'ies'}`);
      }
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        this.fail(path, `must hold at most ${node.maxItems} entries`);
      }
      if (node.uniqueItems) {
        const seen = new Set<string>();
        value.forEach((entry, index) => {
          const key = JSON.stringify(entry) ?? String(entry);
          if (seen.has(key)) this.fail(pointerJoin(path, index), 'is a duplicate');
          seen.add(key);
        });
      }
      if (node.items) {
        value.forEach((entry, index) => this.check(node.items as SchemaNode, entry, pointerJoin(path, index)));
      }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          this.fail(path, `is missing the required property "${key}"`);
        }
      }
      const properties = node.properties ?? {};
      for (const key of Object.keys(record)) {
        const childPath = pointerJoin(path, key);
        const declared = properties[key];
        if (declared) {
          this.check(declared, record[key], childPath);
          continue;
        }
        if (node.additionalProperties === false) {
          this.fail(
            childPath,
            `is not a property this format defines (known: ${Object.keys(properties).join(', ') || 'none'})`
          );
        } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
          this.check(node.additionalProperties, record[key], childPath);
        }
      }
    }

    if (node.allOf) {
      for (const member of node.allOf) this.check(member, value, path);
    }

    if (node.anyOf) {
      if (!node.anyOf.some((member) => this.satisfies(member, value))) {
        this.fail(path, 'must satisfy at least one of the allowed forms');
      }
    }

    if (node.oneOf) {
      const matches = node.oneOf.filter((member) => this.satisfies(member, value));
      if (matches.length > 1) {
        this.fail(path, 'matches more than one of the allowed forms');
      } else if (matches.length === 1) {
        // Valid. Nothing to say.
      } else {
        // Nothing matched. Every branch in the EUSnips schema is discriminated —
        // a body is a string *or* a list of nodes, a body node is told apart from
        // its siblings by its `type` — so the branch worth reporting is the one
        // the value was aimed at. Reporting it is what turns "it is not any of
        // these five things" into "the tab stop's third property is the problem",
        // and it keeps a string body from being described in the vocabulary of
        // body nodes.
        const typed = this.branchFor(node.oneOf, value);
        this.check(typed ?? node.oneOf[0], value, path);
      }
    }

    // `not` is only ever used here as `not: { required: [...] }`, i.e. "these two
    // properties must not appear together", so it is checked directly rather than
    // by running a full sub-validation and negating it.
    if (node.not) {
      const forbidden = node.not.required ?? [];
      if (forbidden.length > 0 && value && typeof value === 'object') {
        const present = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
        if (present.length === forbidden.length) {
          this.fail(path, `must not combine ${forbidden.map((key) => `"${key}"`).join(' and ')}`);
        }
      }
    }
  }

  /** Whether a subschema accepts a value, without recording issues. */
  private satisfies(node: SchemaNode, value: unknown): boolean {
    const probe = new Validator(this.schema);
    probe.check(node, value, '');
    return probe.issues.length === 0;
  }

  /**
   * The branch of a `oneOf` a value was aimed at, for error reporting.
   *
   * Two discriminators cover the whole schema, and the specific one is checked
   * first: a `type` property constrained by `const` says which body node this is,
   * and the root `type` says whether a body is a string or a list. A schema with
   * neither falls back to the first branch, which is how the EUSnips schema is
   * ordered anyway — most specific first.
   */
  private branchFor(branches: SchemaNode[], value: unknown): SchemaNode | undefined {
    const resolved = branches.map((branch) => this.deref(branch));

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const marker = (value as Record<string, unknown>).type;
      if (typeof marker === 'string') {
        const byConst = resolved.find((branch) => branch.properties?.type?.const === marker);
        if (byConst) return byConst;
      }
    }

    return resolved.find((branch) => expectsType(branch, typeTag(value)));
  }
}

/** The JSON Schema type name a value has, with integers told apart from numbers. */
function typeTag(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** Whether a branch's root `type` admits a value of that type. */
function expectsType(node: SchemaNode, tag: string): boolean {
  if (node.type === undefined) return false;
  const declared = Array.isArray(node.type) ? node.type : [node.type];
  return declared.some((candidate) => candidate === tag || (candidate === 'number' && tag === 'integer'));
}

/**
 * Validates a parsed document against the EUSnips schema.
 *
 * Never throws: a document that is not the right shape at all comes back with a
 * single issue rather than an exception, because the caller's job is to show the
 * problem.
 */
export function validateSnippetFile(document: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues = new Validator(EUSNIPS_SCHEMA as SchemaNode).run(document);
  if (options.text === undefined || issues.length === 0) {
    return { valid: issues.length === 0, issues };
  }

  // One walk of the file for every issue that needs locating, rather than one
  // walk each: resolving them individually cost about 20 ms *per issue* on a
  // 300 KB library, which is twenty-eight seconds for a file with a problem in
  // most of its entries.
  const text = options.text;
  const located = issues.slice(0, MAX_LOCATED_ISSUES);
  const offsets = offsetsOfJsonPointers(
    text,
    located.map((issue) => issue.path)
  );
  return {
    valid: false,
    issues: issues.map((issue, at) => {
      const offset = at < located.length ? offsets.get(issue.path) : undefined;
      if (offset === undefined) return issue;
      return { ...issue, position: positionOfOffset(text, offset) };
    })
  };
}

/**
 * How many issues are located in the file's own text.
 *
 * One walk of the text serves every issue, so the cost is paid by the second
 * issue either way; the cap is there because the *positions* are for a reader,
 * and a reader stops being helped by the four-hundredth line number long before
 * the editor stops being slowed by producing it. Issues past the cap keep their
 * path and their message, which is what a caller acts on.
 */
const MAX_LOCATED_ISSUES = 200;

/** One line per issue, the shape a status bar or log line wants. */
export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path === '' ? 'the file' : issue.path.replace(/^\//, '').replace(/\//g, '.');
      const line = issue.position ? ` (line ${issue.position.line})` : '';
      return `${where}: ${issue.message}${line}`;
    })
    .join('\n');
}

/**
 * Whether a value is a syntactically valid regular expression.
 *
 * The schema can only constrain the *flags* string; whether the pattern itself
 * compiles is a JavaScript question, so it is answered here and reported through
 * the same issue list as everything else.
 */
export function checkRegexTrigger(pattern: string, flags: string): string | undefined {
  if (pattern.length === 0) return 'the pattern must not be empty';
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
