import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTypeScript } from '../helpers/register-typescript.mjs';
const handlers = new Map();
globalThis.protocolTestHandlers = handlers;
registerTypeScript({
  electron:
    'data:text/javascript,export const app={};export const BrowserWindow={getAllWindows:()=>[]};export const ipcMain={handle:(key,fn)=>globalThis.protocolTestHandlers.set(key,fn)};',
  [new URL('../../src/main/ipc/appHandler', import.meta.url).href]:
    'data:text/javascript,export function logToFile(){};export function rememberWorkspace(){};',
});
const {
  deliverProtocolRequest,
  resetProtocolDelivery,
  registerProtocolHandlers,
} = await import('../../src/main/protocol.ts');
registerProtocolHandlers();

test('file and project requests wait through setup and are drained once', async () => {
  const sent = [];
  const sender = {
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
  };
  const window = { webContents: sender };
  const first = { kind: 'open', path: 'D:/Papers/Notes.tex', line: 7 };
  const second = { kind: 'project', path: 'D:/Papers/Book' };
  deliverProtocolRequest(first, window);
  deliverProtocolRequest(second, window);
  assert.deepEqual(sent, []);
  assert.deepEqual(await handlers.get('protocol:pending')({ sender }), [
    first,
    second,
  ]);
  assert.deepEqual(await handlers.get('protocol:pending')({ sender }), []);
  deliverProtocolRequest(first, window);
  assert.deepEqual(sent, [['protocol:openFile', first]]);
});

test('reloading a renderer returns delivery to the queue until ready', async () => {
  const sent = [];
  const sender = {
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
  };
  const window = { webContents: sender };
  await handlers.get('protocol:pending')({ sender });
  resetProtocolDelivery(window);
  const request = { kind: 'open', path: 'D:/Papers/Next.tex' };
  deliverProtocolRequest(request, window);
  assert.deepEqual(sent, []);
  assert.deepEqual(await handlers.get('protocol:pending')({ sender }), [
    request,
  ]);
});
