const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(async () => {
  try {
    for (const scenario of ['normal', 'missing-parser']) {
      const win = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: false, contextIsolation: true, partition: scenario,
      } });
      if (scenario === 'missing-parser') {
        win.webContents.session.webRequest.onBeforeRequest((details, done) => {
          done({ cancel: details.url.endsWith('/tikzcd-parser.mjs') });
        });
      }
      await win.loadFile(path.join(process.argv[2], 'index.html'), { query: { scenario } });
      const result = await win.webContents.executeJavaScript('window.mathjaxRendererTest');
      if (result.error) throw new Error(`${scenario}: ${result.error}`);
      console.log(`PASS MathJax file:// renderer: ${scenario}`);
      win.destroy();
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
app.on('window-all-closed', () => {});
