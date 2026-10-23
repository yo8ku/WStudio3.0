/** 文件说明：直接运行已构建的 Tauri release，日常启动不运行 Vite 或 Cargo。 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseDirectory = fileURLToPath(new URL('../src-tauri/target/release/', import.meta.url));
const executablePath = join(releaseDirectory, process.platform === 'win32' ? 'wstudio.exe' : 'wstudio');

try {
  if (!(await stat(executablePath)).isFile()) throw new Error('Release executable is missing.');
  const child = spawn(executablePath, [], {
    cwd: dirname(executablePath),
    stdio: 'inherit',
    windowsHide: true
  });
  child.once('error', error => {
    console.error(`WStudio 启动失败：${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error('请先执行 npm run build:tauri 构建 release，之后使用 npm start 快速启动。');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
