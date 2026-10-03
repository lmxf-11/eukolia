/**
 * Eukolia — VS Code compatibility layer: language feature value types.
 *
 * These are the data carriers that ported completion / diagnostics / formatting
 * code produces. They are plain, honest implementations — Eukolia's editor
 * adapters consume them directly.
 */

import { Position, Range } from './position';
import { Uri } from './uri';

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2
}

export enum InsertTextFormat {
  PlainText = 1,
  Snippet = 2
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2
}

export enum DocumentHighlightKind {
  Text = 0,
  Read = 1,
  Write = 2
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3
}

export class MarkdownString {
  public value: string;
  public isTrusted = false;
  public supportThemeIcons = false;

  constructor(value = '') {
    this.value = value;
  }

  appendText(value: string): MarkdownString {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

export class Hover {
  constructor(
    public contents: MarkdownString[],
    public range?: Range
  ) {}
}

export class SnippetString {
  public value: string;

  constructor(value?: string) {
    this.value = value ?? '';
  }

  appendText(value: string): SnippetString {
    this.value += value.replace(/\$|}|\\/g, '\\$&');
    return this;
  }

  appendTabstop(number = 0): SnippetString {
    this.value += `$${number}`;
    return this;
  }

  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = 0): SnippetString {
    if (typeof value === 'function') {
      const nested = new SnippetString();
      value(nested);
      this.value += `\${${number}:${nested.value}}`;
    } else {
      this.value += `\${${number}:${value}}`;
    }
    return this;
  }

  appendChoice(values: readonly string[], number = 0): SnippetString {
    this.value += `\${${number}|${values.join(',')}|}`;
    return this;
  }

  appendVariable(name: string, defaultValue?: string | ((snippet: SnippetString) => unknown)): SnippetString {
    if (typeof defaultValue === 'function') {
      const nested = new SnippetString();
      defaultValue(nested);
      this.value += `\${${name}:${nested.value}}`;
    } else if (defaultValue !== undefined) {
      this.value += `\${${name}:${defaultValue}}`;
    } else {
      this.value += `\${${name}}`;
    }
    return this;
  }
}

export class CompletionItem {
  label: string | { label: string; description?: string; detail?: string };
  kind?: CompletionItemKind;
  tags?: readonly DiagnosticTag[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  additionalTextEdits?: TextEdit[];
  command?: Command;
  data?: unknown;

  constructor(label: string | { label: string; description?: string; detail?: string }, kind?: CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }

  get labelText(): string {
    return typeof this.label === 'string' ? this.label : this.label.label;
  }
}

export class CompletionList {
  isIncomplete = false;

  constructor(
    public items: CompletionItem[] = [],
    isIncomplete = false
  ) {
    this.isIncomplete = isIncomplete;
  }
}

export class TextEdit {
  constructor(
    public range: Range,
    public newText: string
  ) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
}

export class WorkspaceEdit {
  private readonly edits = new Map<string, TextEdit[]>();

  get size(): number {
    let n = 0;
    for (const list of this.edits.values()) n += list.length;
    return n;
  }

  replace(uri: Uri, range: Range, newText: string): void {
    this.push(uri, new TextEdit(range, newText));
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.push(uri, TextEdit.insert(position, newText));
  }

  delete(uri: Uri, range: Range): void {
    this.push(uri, TextEdit.delete(range));
  }

  set(uri: Uri, edits: TextEdit[]): void {
    this.edits.set(uri.toString(), [...edits]);
  }

  get(uri: Uri): TextEdit[] {
    return this.edits.get(uri.toString()) ?? [];
  }

  entries(): Array<[Uri, TextEdit[]]> {
    return [...this.edits.entries()].map(([key, value]) => [Uri.parse(key), value]);
  }

  private push(uri: Uri, edit: TextEdit): void {
    const key = uri.toString();
    const list = this.edits.get(key);
    if (list) list.push(edit);
    else this.edits.set(key, [edit]);
  }
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export class Diagnostic {
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  codeValue?: string | number;
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: readonly DiagnosticTag[];
  data?: unknown;

  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ) {}

  static create(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): Diagnostic {
    return new Diagnostic(range, message, severity);
  }
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string
  ) {}
}

export class Location {
  constructor(
    public uri: Uri,
    public range: Range
  ) {}
}

export class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: DocumentHighlightKind = DocumentHighlightKind.Text
  ) {}
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind
  ) {}
}

export class SymbolInformation {
  constructor(
    public name: string,
    public kind: SymbolKind,
    public containerName: string,
    public location: Location
  ) {}
}

export class DocumentLink {
  constructor(
    public range: Range,
    public target?: Uri,
    public tooltip?: string
  ) {}
}

export class CallHierarchyItem {
  constructor(
    public name: string,
    public kind: SymbolKind,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range
  ) {}
}
