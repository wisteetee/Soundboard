const { app, BrowserWindow } = require('electron');
const fs = require('fs');
require('./main.js');
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise(r => setTimeout(r, 1800));
  const run = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`);
  const r = await run(`return JSON.stringify(await window.sb.vcclient.install());`);
  fs.writeFileSync(require('path').join(require('os').tmpdir(), 'dl2078_result.txt'), r);
  app.exit(0);
}, 2600));
