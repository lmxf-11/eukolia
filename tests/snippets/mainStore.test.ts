import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_GLOBALS_JAVASCRIPT,
  USER_GLOBALS_FILENAME,
  USER_SNIPPETS_FILENAME,
  ensureUserSnippetsDirectory,
  readUserSnippetsFile,
  resolveDirectoryPath,
  setUserSnippetsDirectoryOverride,
  userGlobalsFilePath,
  userSnippetsFilePath,
  userSnippetsPath,
  writeUserSnippetsFile
} from '../../src/main/snippets/store';

describe('main snippets store directory and globals management', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-test-snippets-'));
    setUserSnippetsDirectoryOverride(tempDir);
  });

  afterEach(() => {
    setUserSnippetsDirectoryOverride(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it('resolves directory path and environment variables', () => {
    const raw = path.join(tempDir, 'subfolder');
    expect(resolveDirectoryPath(raw)).toBe(path.resolve(raw));
  });

  it('respects setUserSnippetsDirectoryOverride', () => {
    expect(userSnippetsPath()).toBe(path.resolve(tempDir));
    expect(userSnippetsFilePath()).toBe(path.join(path.resolve(tempDir), USER_SNIPPETS_FILENAME));
    expect(userGlobalsFilePath()).toBe(path.join(path.resolve(tempDir), USER_GLOBALS_FILENAME));
  });

  it('ensureUserSnippetsDirectory automatically creates globals.js by default', () => {
    const createdDir = ensureUserSnippetsDirectory();
    expect(createdDir).toBe(path.resolve(tempDir));

    const globalsPath = path.join(createdDir, USER_GLOBALS_FILENAME);
    expect(fs.existsSync(globalsPath)).toBe(true);
    const content = fs.readFileSync(globalsPath, 'utf8');
    expect(content).toBe(DEFAULT_GLOBALS_JAVASCRIPT);
  });

  it('ensureUserSnippetsDirectory seeds globals.js from existing snippets.json if present', () => {
    const customJs = 'function myCustomGlobal() { return "hello"; }';
    const snippetsContent = JSON.stringify({
      version: 1,
      language: 'latex',
      globals: { javascript: customJs },
      snippets: []
    });
    fs.writeFileSync(path.join(tempDir, USER_SNIPPETS_FILENAME), snippetsContent, 'utf8');

    ensureUserSnippetsDirectory();

    const globalsPath = path.join(tempDir, USER_GLOBALS_FILENAME);
    expect(fs.existsSync(globalsPath)).toBe(true);
    expect(fs.readFileSync(globalsPath, 'utf8')).toBe(customJs);
  });

  it('writeUserSnippetsFile writes both snippets.json and globals.js', () => {
    const snippetsJson = JSON.stringify({ version: 1, language: 'latex', snippets: [] });
    const globalsCode = 'const PI = 3.14159;';

    const result = writeUserSnippetsFile(snippetsJson, globalsCode);

    expect(result.exists).toBe(true);
    expect(result.text).toBe(snippetsJson);
    expect(result.globalsJs).toBe(globalsCode);
    expect(result.globalsPath).toBe(path.join(path.resolve(tempDir), USER_GLOBALS_FILENAME));

    const fileContent = fs.readFileSync(path.join(tempDir, USER_SNIPPETS_FILENAME), 'utf8');
    expect(fileContent).toBe(snippetsJson);
    const globalsContent = fs.readFileSync(path.join(tempDir, USER_GLOBALS_FILENAME), 'utf8');
    expect(globalsContent).toBe(globalsCode);
  });

  it('readUserSnippetsFile reads existing snippets.json and globals.js', () => {
    const snippetsJson = JSON.stringify({ version: 1, language: 'latex', snippets: [] });
    const globalsCode = 'function testFn() {}';
    fs.writeFileSync(path.join(tempDir, USER_SNIPPETS_FILENAME), snippetsJson, 'utf8');
    fs.writeFileSync(path.join(tempDir, USER_GLOBALS_FILENAME), globalsCode, 'utf8');

    const result = readUserSnippetsFile();

    expect(result.exists).toBe(true);
    expect(result.text).toBe(snippetsJson);
    expect(result.globalsJs).toBe(globalsCode);
  });
});
