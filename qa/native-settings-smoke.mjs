// Runs on the Windows CI desktop against the real installed WebView2 window.
// All keys are synthetic. No key or token is printed, including on failure.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
let stage='connect';
process.on('uncaughtException',(error)=>{console.error('::error::Native settings '+stage+': '+error.message.replace(/\r?\n/g,' '));process.exit(1);});
const [port, pid] = process.argv.slice(2);
const watchdog=setTimeout(()=>{console.error('Native UI regression timed out');process.exit(1);},45000);
let target;
for (let i = 0; i < 100; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
    if (target) break;
  } catch { /* WebView2 debugging transport is still starting. */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(target, 'Installed native renderer unavailable');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(new Error('Native renderer command failed')); else resolve(message.result);
  }
};
const send = (method, params) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Native renderer evaluation failed');
  return result.result?.value;
};
async function wait(expression) {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Native settings readiness timed out');
}
try {
  await wait("Boolean(document.querySelector('[data-tab=models]'))");
  await evaluate("document.querySelector('[data-tab=models]').click()");
  await wait("Boolean(document.getElementById('provider-key-zai'))");
  const key = 'prorab-native-dummy#key';
  if (process.env.PRORAB_UI_VERIFY_RESTART === '1') {
    stage='restart indicator';
    await wait("document.querySelector('[data-key-status=zai]').textContent === 'Ключ сохранён'");
    assert.equal(await evaluate("document.getElementById('provider-key-zai').value === ''"), true);
    assert.equal(await evaluate(`fetch('/api/state').then(r=>r.text()).then(text=>!text.includes(${JSON.stringify(key)}))`), true);
    console.log('PASS: saved credential indicator survives native application restart; key is not returned by API');
  } else {
    stage='keyboard paste';
    await evaluate("document.getElementById('provider-key-zai').focus()");
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($env:PRORAB_UI_DUMMY); $shell=New-Object -ComObject WScript.Shell; $null=$shell.AppActivate([int]$env:PRORAB_UI_PID); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { env: { ...process.env, PRORAB_UI_DUMMY: key, PRORAB_UI_PID: pid }, stdio: 'pipe' });
    assert.equal(result.status, 0, 'Windows keyboard/clipboard test command failed');
    await wait(`document.getElementById('provider-key-zai').value === ${JSON.stringify(key)}`);
    stage='polling stability';
    // Verify a live polling cycle cannot discard the value being edited.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(await evaluate(`document.getElementById('provider-key-zai').value === ${JSON.stringify(key)}`), true);
    stage='save';
    await evaluate("document.querySelector('[data-provider-id=zai] [name=enabled]').checked=true; document.querySelector('[data-provider-id=zai] button[type=submit]').click()");
    await wait("document.querySelector('[data-key-status=zai]').textContent === 'Ключ сохранён'");
    assert.equal(await evaluate("document.getElementById('provider-key-zai').value === ''"), true);
    console.log('PASS: actual Windows Ctrl+V, stable native field during polling, UI save and saved-key confirmation');
  }
} finally { clearTimeout(watchdog); socket.close(); }
