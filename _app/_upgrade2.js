const { app, BrowserWindow } = require('electron');
require('./main.js');
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise(r => setTimeout(r, 1800));
  const run = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`);
  // affiche la progression via les logs vcclient
  win.webContents.executeJavaScript(`window.sb.vcclient.onLog(l => console.log('VCLOG:'+l));`);
  win.webContents.on('console-message', (_e, lvl, m) => { if (m.startsWith('VCLOG:')) console.log(m); });
  console.log('AVANT:' + await run(`return JSON.stringify(await window.sb.vcclient.status());`));
  const t0 = Date.now();
  const r = await run(`return JSON.stringify(await window.sb.vcclient.install());`);
  console.log('INSTALL(' + Math.round((Date.now()-t0)/1000) + 's):' + r);
  console.log('APRES:' + await run(`return JSON.stringify(await window.sb.vcclient.status());`));
  setTimeout(() => app.exit(0), 300);
}, 2600));
