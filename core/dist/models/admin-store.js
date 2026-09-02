"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');
const ADMIN_FILE = getDataFile('admin.json');
let admins = [];
function normalizeMaxAccounts(raw) {
    const value = Number.parseInt(String(raw), 10);
    if (Number.isFinite(value))
        return value === -1 ? -1 : Math.max(0, value);
    return 1;
}
function normalizeAdmin(raw) {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim())
        return null;
    return {
        username: String(raw.username || 'admin').trim() || 'admin',
        password: String(raw.password),
        createdAt: Number(raw.createdAt) || Date.now(),
        mustChangePassword: raw.mustChangePassword === true || undefined,
        maxAccounts: normalizeMaxAccounts(raw.maxAccounts),
    };
}
function saveAdmins() {
    ensureDataDir();
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ admins }, null, 2), 'utf8');
}
function loadAdmins() {
    ensureDataDir();
    try {
        if (fs.existsSync(ADMIN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
            // 新格式：{ admins: [...] }
            if (Array.isArray(data?.admins)) {
                admins = data.admins
                    .map(normalizeAdmin)
                    .filter(Boolean);
            }
            // 兼容旧格式：{ admin: {...} }
            if (admins.length === 0 && data?.admin) {
                const legacy = normalizeAdmin(data.admin);
                if (legacy) {
                    admins = [legacy];
                    saveAdmins();
                    console.log('[管理员] 已从旧格式迁移到多管理员格式');
                }
            }
        }
    }
    catch {
        admins = [];
    }
    if (admins.length === 0) {
        console.warn('[管理员] 未配置管理员账号，请手动运行 add-admin.js 创建');
    }
    return admins;
}
function getAdminInfo(username) {
    const current = loadAdmins();
    const target = username
        ? current.find(a => a.username === username)
        : current[0];
    if (!target) {
        return { username: username || '', role: 'admin', mustChangePassword: false, maxAccounts: 1 };
    }
    return {
        username: target.username,
        role: 'admin',
        mustChangePassword: target.mustChangePassword === true,
        maxAccounts: target.maxAccounts === undefined ? 1 : target.maxAccounts,
    };
}
function getAdminMaxAccounts(username) {
    const info = getAdminInfo(username);
    return info.maxAccounts;
}
function validateAdmin(username, password, ip = 'unknown') {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed)
        return { error: 'rate_limit', ...rateLimit };
    const lockout = security.checkAdminLockout();
    if (lockout.locked)
        return { error: 'locked', ...lockout };
    const current = loadAdmins();
    if (current.length === 0) {
        return { error: 'no_admin', message: '系统尚未创建管理员账号，请先在项目根目录运行 add-admin.js 创建' };
    }
    const target = current.find(a => a.username === username);
    if (!target || !security.verifyPassword(password, target.password)) {
        const attempt = security.recordFailedAttempt();
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }
    security.clearFailedAttempts();
    if (security.needsRehash(target.password)) {
        target.password = security.hashPassword(password);
        saveAdmins();
    }
    return getAdminInfo(target.username);
}
function changePassword(username, oldPassword, newPassword) {
    const current = loadAdmins();
    const target = current.find(a => a.username === username);
    if (!target)
        return { ok: false, error: '用户不存在' };
    if (!security.verifyPassword(oldPassword, target.password))
        return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(newPassword);
    if (!validation.valid)
        return { ok: false, error: validation.errors.join('；') };
    target.password = security.hashPassword(newPassword);
    delete target.mustChangePassword;
    saveAdmins();
    return { ok: true, message: '密码修改成功' };
}
loadAdmins();
module.exports = { getAdminInfo, getAdminMaxAccounts, validateAdmin, changePassword };
//# sourceMappingURL=admin-store.js.map