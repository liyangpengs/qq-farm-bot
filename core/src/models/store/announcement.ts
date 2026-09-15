export {};

const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');

const ANNOUNCEMENT_FILE: string = getDataFile('announcement.json');

interface Announcement {
    content: string;
    showOnce: boolean;
    updatedAt: number;
    readBy: Record<string, number>;
}

function emptyAnnouncement(): Announcement {
    return { content: '', showOnce: true, updatedAt: 0, readBy: {} };
}

function loadAnnouncement(): Announcement {
    ensureDataDir();
    try {
        if (!fs.existsSync(ANNOUNCEMENT_FILE)) return emptyAnnouncement();
        const data = JSON.parse(fs.readFileSync(ANNOUNCEMENT_FILE, 'utf8'));
        if (!data || typeof data !== 'object') return emptyAnnouncement();
        return {
            content: String(data.content || ''),
            showOnce: data.showOnce !== false,
            updatedAt: Number(data.updatedAt) || 0,
            readBy: (data.readBy && typeof data.readBy === 'object') ? data.readBy : {},
        };
    } catch {
        return emptyAnnouncement();
    }
}

function saveAnnouncement(data: Announcement): void {
    ensureDataDir();
    try {
        fs.writeFileSync(ANNOUNCEMENT_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e: any) {
        console.error('保存公告失败:', e.message);
    }
}

function getAnnouncement(): Announcement {
    return loadAnnouncement();
}

function setAnnouncement(content: unknown, showOnce: unknown): Announcement {
    const data: Announcement = {
        content: String(content || '').trim(),
        showOnce: showOnce !== false,
        updatedAt: Date.now(),
        readBy: {},
    };
    saveAnnouncement(data);
    return data;
}

function shouldShowAnnouncement(username: string): boolean {
    const data = loadAnnouncement();
    if (!data.content) return false;
    if (!data.showOnce) return true;
    if (!username) return true;
    return !data.readBy[String(username)];
}

function markAnnouncementRead(username: string): Announcement {
    const data = loadAnnouncement();
    if (username) {
        data.readBy[String(username)] = Date.now();
        saveAnnouncement(data);
    }
    return data;
}

module.exports = {
    getAnnouncement,
    setAnnouncement,
    shouldShowAnnouncement,
    markAnnouncementRead,
};
