// Открывает страницу в браузере по умолчанию (Windows, macOS, Linux).
import { spawn } from 'node:child_process';

export function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // не получилось — не страшно, ссылка напечатана в окне
    child.unref();
  } catch {
    // то же самое
  }
}
