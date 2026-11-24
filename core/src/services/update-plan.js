const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const workspaces = { web: 'web', backend: 'core', contract: 'packages/session-contract' };
const installStamp = 'node_modules/.cache/farm-install';

function optionalText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return '';
        throw err;
    }
}

function inspectInstallation(root) {
    const hash = crypto.createHash('sha256');
    hash.update([process.platform, process.arch, process.versions.modules].join('/'));
    // pnpm can replace the installed lock independently (e.g. an install on another branch).
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'node_modules/.pnpm/lock.yaml']) {
        hash.update(optionalText(path.join(root, file)));
    }
    let valid = fs.existsSync(path.join(root, 'node_modules/.modules.yaml'));
    for (const dir of ['.', ...Object.values(workspaces)]) {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        hash.update(JSON.stringify([dir, pkg.packageManager, deps, pkg.optionalDependencies, pkg.peerDependencies, pkg.pnpm]));
        const modules = path.join(root, dir, 'node_modules');
        valid &&= Object.keys(deps).every(name => fs.existsSync(path.join(modules, name, 'package.json')));
        const bin = { '.': 'turbo', web: 'vite' }[dir] || 'tsc';
        valid &&= fs.existsSync(path.join(modules, '.bin', bin + (process.platform === 'win32' ? '.cmd' : '')));
    }
    const fingerprint = hash.digest('hex');
    const file = path.join(root, installStamp);
    return { needed: !valid || optionalText(file) !== fingerprint, valid, fingerprint, file };
}

function turboArgs(root, components) {
    return [path.join(root, 'node_modules/turbo/bin/turbo'), 'run', 'build', '--cache=local:rw',
        ...components.map(key => `--filter=./${workspaces[key]}`)];
}

function buildEnv(pnpmCommand = '') {
    const env = { ...process.env, NODE_ENV: 'production', TURBO_TELEMETRY_DISABLED: '1' };
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [path.dirname(process.execPath), path.isAbsolute(pnpmCommand) && path.dirname(pnpmCommand), env[pathKey]].filter(Boolean).join(path.delimiter);
    return env;
}

async function targetFingerprints(root) {
    // On CRLF checkouts Turbo hashes a touched file from disk until Git refreshes its stat entry.
    if (process.platform === 'win32' && fs.existsSync(path.join(root, '.git'))) {
        await exec('git', ['update-index', '-q', '--refresh'], { cwd: root, windowsHide: true });
    }
    const { stdout } = await exec(process.execPath, [...turboArgs(root, ['web', 'backend']), '--dry=json'], {
        cwd: root, env: buildEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const { tasks } = JSON.parse(stdout);
    return Object.fromEntries(['web', 'backend', 'host'].map((key) => {
        const dir = key === 'host' ? workspaces.backend : workspaces[key];
        const name = key === 'host' ? 'host-fingerprint' : 'build';
        const task = tasks.find(task => task.directory === dir && task.task === name);
        if (!task?.hash) throw new Error(`无法检查 ${key === 'web' ? '网页端' : key === 'backend' ? '服务端' : '游戏连接服务'} 的变更状态`);
        return [key, task.hash];
    }));
}

function runningComponents({ repoRoot, runtimeDir, releasesDir, env = process.env, contract = require('@qq-farm-bot/session-contract') }) {
    const { isProcessAlive, readLockMetadata, resolveWebRootInfo } = contract;
    function runningRelease(component, lockName) {
        const lock = readLockMetadata(path.join(runtimeDir, lockName));
        if (!lock || !isProcessAlive(lock.pid, lock.processStart) || !lock.releaseId) return null;
        const dir = path.join(releasesDir, component, lock.releaseId);
        const stamp = component === 'host' ? 'host-fingerprint' : 'build-fingerprint';
        return { id: lock.releaseId, hash: optionalText(path.join(dir, 'dist', stamp)) };
    }
    const backend = runningRelease('backend', 'backend-writer.lock');
    const host = runningRelease('host', 'session-host.lock');
    const appRoot = backend ? path.join(releasesDir, 'backend', backend.id) : path.join(repoRoot, 'core');
    const info = resolveWebRootInfo(runtimeDir, path.resolve(appRoot, '../web/dist'), env);
    const dir = [info.webRoot, ...info.fallbackRoots].find(root => fs.existsSync(path.join(root, 'index.html')));
    const webId = dir && path.relative(path.join(releasesDir, 'web'), dir);
    const manifest = dir && optionalText(path.join(dir, 'version.json'));
    const web = {
        id: /^web-[\w.-]+$/.test(webId) ? webId : '',
        dir,
        hash: manifest ? JSON.parse(manifest).inputHash || '' : '',
    };
    return { web, backend, host };
}

function compareComponents(targets, running) {
    return {
        web: targets.web !== running.web.hash,
        backend: targets.backend !== running.backend?.hash,
        host: running.host && targets.host !== running.host.hash
            ? (running.host.hash ? 'changed' : 'unknown') : '',
    };
}

function hostMaintenanceMessage(state) {
    if (state === 'changed') return '游戏连接服务有更新，本次继续使用在线版本。可在结束挂机后单独升级。';
    if (state === 'unknown') return '在线的游戏连接服务缺少版本记录，暂时无法判断是否需要升级。当前挂机继续。';
    return '';
}

module.exports = { installStamp, inspectInstallation, turboArgs, buildEnv, targetFingerprints, runningComponents, compareComponents, hostMaintenanceMessage };
