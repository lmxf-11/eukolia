// Ported from References/hypersnips/src/utils.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.

import * as vscode from 'vscode';

export function lineRange(character: number, position: vscode.Position): vscode.Range {
  return new vscode.Range(position.line, character, position.line, position.character);
}

function RegReplace(text: string, reg: RegExp, replaceFn: (match: RegExpExecArray) => string): string {
    let result = '';
    let last = 0;
    while (true) {
        let match = reg.exec(text);
        if (!match) break;
        result += text.slice(last, match.index) + replaceFn(match);
        last = match.index + match[0].length;
    }
    result += text.slice(last);
    return result;
}

/**
 * Eukolia modification: the reference resolved the snippet directory from
 * `os.platform()`, `process.env` and the `hsnips.windows|mac|linux` settings.
 * The renderer must not reach for Node globals, so the platform and the
 * environment lookup are injectable. `getSnippetDir` keeps the reference
 * algorithm (including its `%VAR%` / `$VAR` expansion and Windows separator
 * rewrite) and defaults to the same VS Code user directory layout, which is
 * also the layout HyperSnips users already have on disk.
 */
export interface SnippetDirEnvironment {
  platform: string;
  getEnv(name: string): string | undefined;
}

let environment: SnippetDirEnvironment = {
  platform: 'win32',
  getEnv: (name) => {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.[name];
  }
};

export function setSnippetDirEnvironment(env: SnippetDirEnvironment): void {
  environment = env;
}

export function getSnippetDir(): string {
  let platform = environment.platform;

  function parse_path(path: string) {
    // replace all %VAR% with their respective env vars
    if (platform == 'win32') {
        path = RegReplace(path, /\%(\w+)\%/g, (match) => environment.getEnv(match[1]) || '');
    } else {
        path = RegReplace(path, /\$(\w+)/g, (match) => environment.getEnv(match[1]) || '');
    }
    if (platform == 'win32') {
        // replace all / with \ for windows
        path = path.replace(/\//g, '\\');
    }
    return path;
  }

  if (platform == 'win32') {
    let path: string | undefined = vscode.workspace.getConfiguration('hsnips').get('windows');
    return parse_path(path ? parse_path(path) : parse_path("%APPDATA%/Code/User/hsnips"));
  } else if (platform == 'darwin') {
    let path: string | undefined = vscode.workspace.getConfiguration('hsnips').get('mac');
    return parse_path(path ? parse_path(path) : parse_path("$HOME/Library/Application Support/Code/User/hsnips"));
  } else {
    let path: string | undefined = vscode.workspace.getConfiguration('hsnips').get('linux');
    return parse_path(path ? parse_path(path) : parse_path("$HOME/.config/Code/User/hsnips"));
  }
}

export function applyOffset(
  position: vscode.Position,
  text: string,
  indent: number
): vscode.Position {
  text = text.replace('\\$', '$');
  let lines = text.split('\n');
  let newLine = position.line + lines.length - 1;
  let charOffset = lines[lines.length - 1].length;

  let newChar = position.character + charOffset;
  if (lines.length > 1) newChar = indent + charOffset;

  return position.with(newLine, newChar);
}

export function getWorkspaceUri(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.toString() ?? "";
}
