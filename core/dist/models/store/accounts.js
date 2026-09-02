"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('node:fs');
const { ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../../services/json-db');
const { ACCOUNTS_FILE } = require('./shared-state');
function loadAccounts() {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    const normalized = normalizeAccountsData(data);
    // 迁移：清除无归属账号（不再运行，等待通过管理面板按归属重建）
    const ownerless = normalized.accounts.filter(a => !String(a.owner || '').trim());
    if (ownerless.length > 0) {
        normalized.accounts = normalized.accounts.filter(a => String(a.owner || '').trim());
        saveAccounts(normalized);
        for (const removed of ownerless) {
            try {
                require('./account-config').removeAccountConfig(removed.id);
            }
            catch { }
            console.warn(`[账号] 已清除无归属账号: ${removed.id} (${removed.name})`);
        }
        console.warn(`[账号] 已清除 ${ownerless.length} 个无归属账号，不再运行`);
    }
    return normalized;
}
function saveAccounts(data) {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}
function getAccounts() {
    return loadAccounts();
}
function normalizeAccountsData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map(normalizeAccount);
    const maxId = accounts.reduce((m, a) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0)
        nextId = maxId + 1;
    if (accounts.length === 0)
        nextId = 1;
    if (nextId <= maxId)
        nextId = maxId + 1;
    return { accounts, nextId };
}
function normalizeAccount(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const account = {
        id: String(source.id || ''),
        name: String(source.name || ''),
        code: String(source.code || ''),
        loginBuffer: String(source.loginBuffer || ''),
        platform: String(source.platform || 'qq'),
        uin: String(source.uin || ''),
        qq: String(source.qq || source.uin || ''),
        avatar: String(source.avatar || source.avatarUrl || ''),
        owner: String(source.owner || ''),
        createdAt: Number(source.createdAt) || Date.now(),
        updatedAt: Number(source.updatedAt) || Date.now(),
    };
    const nick = String(source.nick || '').trim();
    if (nick)
        account.nick = nick;
    return account;
}
function addOrUpdateAccount(acc) {
    const { ensureAccountConfig, removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    const source = acc || {};
    const cleanAccount = {};
    for (const key of ['id', 'name', 'code', 'loginBuffer', 'platform', 'uin', 'qq', 'avatar', 'avatarUrl', 'nick', 'owner']) {
        if (source[key] !== undefined)
            cleanAccount[key] = source[key];
    }
    acc = cleanAccount;
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    }
    else {
        // 检查当前管理员名下账户数量上限（按 admin.json 中该管理员的 maxAccounts，-1 表示不限制）
        const maxAccounts = Number(require('../admin-store').getAdminMaxAccounts(String(acc.owner || '')));
        const ownerKey = String(acc.owner || '').trim();
        const ownerCount = data.accounts.filter(a => String(a.owner || '').trim() === ownerKey).length;
        if (maxAccounts !== -1 && ownerCount >= maxAccounts) {
            const err = new Error(`当前管理员的农场账户数量已达上限 (${maxAccounts})，无法添加新账号`);
            err.code = 'MAX_ACCOUNTS_REACHED';
            throw err;
        }
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            loginBuffer: acc.loginBuffer ? String(acc.loginBuffer) : '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            owner: acc.owner ? String(acc.owner) : '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return data;
}
function deleteAccount(id) {
    const { removeAccountConfig } = require('./account-config');
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}
module.exports = {
    loadAccounts,
    saveAccounts,
    getAccounts,
    normalizeAccountsData,
    addOrUpdateAccount,
    deleteAccount,
};
//# sourceMappingURL=accounts.js.map