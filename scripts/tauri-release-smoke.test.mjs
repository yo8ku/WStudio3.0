/** 文件说明：用真实子进程验证 release 烟测的退出诊断与进程回收。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyProcessStartup, verifyReleaseFiles } from './tauri-release-smoke.mjs';

/** 独立发布目录夹具，断言失败时也清理，绝不访问用户配置目录。 */
function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wstudio-release-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  };
  put('src-tauri/tauri.conf.json', JSON.stringify({ productName: 'WStudio', version: '9.1.2' }));
  put('src-tauri/target/release/wstudio.exe', 'fixture exe');
  put('src-tauri/target/release/bundle/nsis/WStudio_9.1.2_x64-setup.exe', 'fixture installer');
  put('plugin/core-plugins/example/assets/icon.svg', '<svg/>');
  put('src-tauri/target/release/plugin/core-plugins/example/assets/icon.svg', '<svg/>');
  return { root, put };
}

test('版本升级后按构建配置定位安装包，并核对嵌套资源', t => {
  const { root } = releaseFixture(t);
  assert.equal(verifyReleaseFiles(root).sourceFiles, 1);
});

test('资源数量相同但内容被修改时拒绝通过', t => {
  const { root, put } = releaseFixture(t);
  put('src-tauri/target/release/plugin/core-plugins/example/assets/icon.svg', '<svg>changed</svg>');
  assert.throws(() => verifyReleaseFiles(root), /resource mismatch/);
});

test('发布资源不能通过符号链接逃出插件目录', t => {
  const { root, put } = releaseFixture(t);
  put('outside.txt', 'outside');
  const link = join(root, 'src-tauri/target/release/plugin/core-plugins/example/assets/outside.txt');
  try {
    symlinkSync(join(root, 'outside.txt'), link, 'file');
  } catch (error) {
    t.skip(`symbolic links unavailable: ${error.message}`);
    return;
  }
  assert.throws(() => verifyReleaseFiles(root), /resource count differs|resource mismatch/);
});

test('发布目录遗漏或多出资源时拒绝通过', t => {
  const { root, put } = releaseFixture(t);
  put('plugin/core-plugins/example/main.js', 'export {}');
  assert.throws(() => verifyReleaseFiles(root), /resource count differs/);
  put('src-tauri/target/release/plugin/core-plugins/example/main.js', 'export {}');
  put('src-tauri/target/release/plugin/core-plugins/obsolete/main.js', 'old');
  assert.throws(() => verifyReleaseFiles(root), /resource count differs/);
});

test('空安装包不是有效发布产物', t => {
  const { root, put } = releaseFixture(t);
  put('src-tauri/target/release/bundle/nsis/WStudio_9.1.2_x64-setup.exe', '');
  assert.throws(() => verifyReleaseFiles(root), /empty release artifact/);
});

test('烟测拒绝提前退出的进程，即使退出码是 0', async () => {
  await assert.rejects(
    verifyProcessStartup({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      observationMs: 1000
    }),
    /exited during startup/
  );
});

test('烟测拒绝被信号终止的进程', async () => {
  await assert.rejects(
    verifyProcessStartup({
      executable: process.execPath,
      args: ['-e', 'process.kill(process.pid)'],
      observationMs: 1000
    }),
    /exited during startup/
  );
});

test('烟测成功后回收本次启动的子进程', async () => {
  const result = await verifyProcessStartup({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    observationMs: 500
  });
  assert.ok(Number.isInteger(result.pid));
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});

test('启动路径不存在时直接返回错误', async () => {
  await assert.rejects(
    verifyProcessStartup({ executable: 'wstudio-nonexistent-executable-47fe', observationMs: 1000 }),
    /failed to start/
  );
});
