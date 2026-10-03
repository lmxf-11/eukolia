import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { registerTypeScript } from '../helpers/register-typescript.mjs';
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
  url: 'https://eukolia.test/',
});
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'Node',
  'Event',
  'MouseEvent',
  'CustomEvent',
])
  globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const stateModule = new URL('../../src/renderer/ui/state', import.meta.url)
  .href;
registerTypeScript({
  [stateModule]:
    'data:text/javascript,export function useAppState(){return globalThis.libraryTestState}',
});
const { createRoot } = await import('react-dom/client');
const {
  ProjectLibraryGate,
  ProjectLibraryDialog,
  LibraryHome,
  showProjectLibrary,
} = await import('../../src/renderer/ui/components/ProjectLibrary.tsx');
const root = createRoot(document.getElementById('root'));
const status = {
  root: 'D:/Library',
  configuredRoot: 'D:/Library',
  templates: ['Article.tex', 'Book.tex'],
  inputs: ['theorems.tex'],
  hasMacros: true,
  projects: [],
};
const calls = [];
globalThis.libraryTestState = {
  recentWorkspaces: [],
  openFolder: async (path) => calls.push(['folder', path]),
  openFile: async (path) => calls.push(['file', path]),
};
const tick = async (fn) => {
  await act(async () => {
    await fn();
    await Promise.resolve();
  });
};
const button = (text) =>
  [...document.querySelectorAll('button')].find((node) =>
    node.textContent.includes(text),
  );
const render = async (element) => tick(() => root.render(element));
const clear = async () => render(null);
function api(overrides = {}) {
  window.eukoliaApi = {
    getProjectLibrary: async () => status,
    chooseProjectLibrary: async () => status,
    closeWindow: async () => {},
    openLibrarySettings: async () => {},
    createLibraryProject: async (request) => {
      calls.push(['create', request]);
      return {
        directory: `D:/Library/${request.name}`,
        mainFile: `D:/Library/${request.name}/${request.name}.tex`,
      };
    },
    ...overrides,
  };
}

test('first-run setup gates services, handles cancel, and continues after choosing a folder', async () => {
  api({
    getProjectLibrary: async () => ({ ...status, root: null }),
    chooseProjectLibrary: async () => null,
  });
  await render(
    React.createElement(
      ProjectLibraryGate,
      null,
      React.createElement('div', { 'data-app': true }, 'Application'),
    ),
  );
  assert.ok(document.body.textContent.includes('A home for your ideas.'));
  assert.equal(document.querySelector('[data-app]'), null);
  await tick(() => button('Choose or create').click());
  assert.equal(document.querySelector('[data-app]'), null);
  window.eukoliaApi.chooseProjectLibrary = async () => status;
  await tick(() => button('Choose or create').click());
  assert.ok(document.querySelector('[data-app]'));
  await clear();
});

test('existing library opens directly; unavailable library offers recovery', async () => {
  api();
  await render(
    React.createElement(
      ProjectLibraryGate,
      null,
      React.createElement('div', { 'data-app': true }, 'Application'),
    ),
  );
  assert.ok(document.querySelector('[data-app]'));
  await clear();
  api({
    getProjectLibrary: async () => ({
      ...status,
      root: null,
      error: 'Drive unavailable',
    }),
  });
  await render(
    React.createElement(
      ProjectLibraryGate,
      null,
      React.createElement('div', { 'data-app': true }, 'Application'),
    ),
  );
  assert.match(
    document.querySelector('[role=alert]').textContent,
    /Drive unavailable/,
  );
  assert.ok(button('Choose or create'));
  await clear();
});

test('home and new-project dialog submit selected template and input choices, then open the document', async () => {
  api();
  calls.length = 0;
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(LibraryHome),
      React.createElement(ProjectLibraryDialog),
    ),
  );
  await tick(() => button('New project').click());
  assert.ok(document.querySelector('[role=dialog]'));
  const input = document.querySelector(
    'input[placeholder="e.g. Algebraic topology"]',
  );
  await tick(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set.call(input, 'Notes');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const select = document.querySelector('select');
  await tick(() => {
    select.value = 'Book.tex';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const checks = [...document.querySelectorAll('input[type=checkbox]')];
  await tick(() => checks[0].click());
  await tick(() => checks[1].click());
  await tick(() =>
    document
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.deepEqual(calls, [
    [
      'create',
      {
        name: 'Notes',
        template: 'Book.tex',
        copyMacros: false,
        inputs: ['theorems.tex'],
      },
    ],
    ['folder', 'D:/Library/Notes'],
    ['file', 'D:/Library/Notes/Notes.tex'],
  ]);
  assert.equal(document.querySelector('[role=dialog]'), null);
  await clear();
});

test('creation failures stay visible and retain the form', async () => {
  api({
    createLibraryProject: async () => {
      throw new Error('A project with that name already exists.');
    },
  });
  await render(React.createElement(ProjectLibraryDialog));
  await tick(() => showProjectLibrary('create'));
  const input = document.querySelector(
    'input[placeholder="e.g. Algebraic topology"]',
  );
  await tick(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set.call(input, 'Notes');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tick(() =>
    document
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.match(
    document.querySelector('[role=alert]').textContent,
    /already exists/,
  );
  assert.equal(input.value, 'Notes');
  assert.equal(button('Create project').disabled, false);
  await clear();
});
