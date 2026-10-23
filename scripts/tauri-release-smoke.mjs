/** 文件说明：验证 Tauri release 可执行文件、安装包和核心插件资源。 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(scriptDirectory, '..');
const releaseDirectory = join(rootDirectory, 'src-tauri', 'target', 'release');
const executablePath = join(releaseDirectory, 'wstudio.exe');

function fail(message) {
  throw new Error(`[tauri-release-smoke] ${message}`);
}

/** 枚举需要逐项核验的插件资源，包括嵌套目录。 */
function listFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    })
    .sort();
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 校验发布文件与插件内容，不启动应用；版本取自 Tauri 构建配置。 */
export function verifyReleaseFiles(projectDirectory = rootDirectory) {
  const configuration = JSON.parse(readFileSync(join(projectDirectory, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const releaseDirectory = join(projectDirectory, 'src-tauri', 'target', 'release');
  const executablePath = join(releaseDirectory, 'wstudio.exe');
  const installerPath = join(
    releaseDirectory, 'bundle', 'nsis', `${configuration.productName}_${configuration.version}_x64-setup.exe`
  );
  const sourcePluginDirectory = join(projectDirectory, 'plugin', 'core-plugins');
  const releasePluginDirectory = join(releaseDirectory, 'plugin', 'core-plugins');
  for (const filePath of [executablePath, installerPath]) {
    if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
      fail(`missing or empty release artifact: ${relative(projectDirectory, filePath)}`);
    }
  }

  const sourceFiles = listFiles(sourcePluginDirectory);
  const releaseFiles = listFiles(releasePluginDirectory);
  if (sourceFiles.length === 0) fail('no core plugin resources found in source tree');
  if (sourceFiles.length !== releaseFiles.length) {
    fail(`core plugin resource count differs: source=${sourceFiles.length}, release=${releaseFiles.length}`);
  }

  for (const sourceFile of sourceFiles) {
    const relativePath = relative(sourcePluginDirectory, sourceFile);
    const releaseFile = join(releasePluginDirectory, relativePath);
    if (!existsSync(releaseFile) || hashFile(sourceFile) !== hashFile(releaseFile)) {
      fail(`core plugin resource mismatch: ${relativePath}`);
    }
  }

  return { sourceFiles: sourceFiles.length, executablePath, installerPath };
}

/** 观察本次启动的子进程，并在成功或失败后限时回收。 */
export async function verifyProcessStartup({
  executable = executablePath,
  args = [],
  cwd = dirname(executable),
  observationMs = 8000,
  shutdownMs = 5000
} = {}) {
  const child = spawn(executable, args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true
  });

  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  let observationTimer;
  try {
    await new Promise((resolveObservation, rejectObservation) => {
      child.once('error', error => rejectObservation(
        new Error(`[tauri-release-smoke] release process failed to start: ${error.message}`)
      ));
      child.once('exit', (code, signal) => rejectObservation(
        new Error(`[tauri-release-smoke] release process exited during startup: code=${code}, signal=${signal}`)
      ));
      observationTimer = setTimeout(resolveObservation, observationMs);
    });
  } finally {
    clearTimeout(observationTimer);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    let shutdownTimer;
    try {
      await Promise.race([
        closed,
        new Promise((_, rejectShutdown) => {
          shutdownTimer = setTimeout(() => rejectShutdown(
            new Error('[tauri-release-smoke] release process cleanup timed out')
          ), shutdownMs);
        })
      ]);
    } finally {
      clearTimeout(shutdownTimer);
    }
  }
  return { pid: child.pid };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = verifyReleaseFiles();
  await verifyProcessStartup();
  console.log(
    `[tauri-release-smoke] passed: exe=${statSync(executablePath).size} bytes, ` +
      `installer=${statSync(artifacts.installerPath).size} bytes, ` +
      `corePluginFiles=${artifacts.sourceFiles}`
  );
}
