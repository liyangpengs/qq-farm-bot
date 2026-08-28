export {};

const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../../package.json');
const { getDataFile } = require('../config/runtime-paths');

interface PerformanceMetricsStoreOptions {
    directory?: string;
    now?: () => number;
    retentionDays?: number;
}

const METRICS_FILE_PATTERN = /^task-metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

class PerformanceMetricsStore {
    readonly directory: string;
    readonly retentionDays: number;
    private readonly now: () => number;
    private lastCleanupAt = 0;

    constructor(options: PerformanceMetricsStoreOptions = {}) {
        this.directory = options.directory || getDataFile('performance');
        this.retentionDays = boundedInteger(
            options.retentionDays ?? process.env.FARM_PERF_RETENTION_DAYS,
            7,
            1,
            90,
        );
        this.now = options.now || Date.now;
    }

    append(record: any): void {
        if (!record || typeof record !== 'object') return;
        fs.mkdirSync(this.directory, { recursive: true });
        const timestamp = Number(record.windowEndedAt) || this.now();
        const filePath = path.join(this.directory, `task-metrics-${this.dateKey(timestamp)}.jsonl`);
        fs.appendFileSync(filePath, `${JSON.stringify({ ...record, schemaVersion: 1, botVersion: version })}\n`, 'utf8');
        this.cleanupExpiredFiles();
    }

    getStatus(): any {
        return {
            enabled: true,
            directory: this.directory,
            retentionDays: this.retentionDays,
            files: this.listFiles().map(file => ({
                name: file.name,
                size: file.size,
                modifiedAt: file.modifiedAt,
            })),
        };
    }

    listExportFiles(days: number): string[] {
        const count = boundedInteger(days, 1, 1, 30);
        const cutoff = this.dateKey(this.now() - (count - 1) * DAY_MS);
        return this.listFiles()
            .filter(file => file.dateKey >= cutoff)
            .map(file => path.join(this.directory, file.name));
    }

    private listFiles(): Array<{ name: string; dateKey: string; size: number; modifiedAt: number }> {
        if (!fs.existsSync(this.directory)) return [];
        return fs.readdirSync(this.directory, { withFileTypes: true })
            .filter((entry: any) => entry.isFile() && METRICS_FILE_PATTERN.test(entry.name))
            .map((entry: any) => {
                const stat = fs.statSync(path.join(this.directory, entry.name));
                return {
                    name: entry.name,
                    dateKey: entry.name.match(METRICS_FILE_PATTERN)[1],
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                };
            })
            .sort((left: any, right: any) => left.name.localeCompare(right.name));
    }

    private cleanupExpiredFiles(): void {
        const now = this.now();
        if (now - this.lastCleanupAt < 60 * 60 * 1000) return;
        this.lastCleanupAt = now;
        const cutoff = this.dateKey(now - (this.retentionDays - 1) * DAY_MS);
        for (const file of this.listFiles()) {
            if (file.dateKey >= cutoff) continue;
            fs.unlinkSync(path.join(this.directory, file.name));
        }
    }

    private dateKey(timestamp: number): string {
        return new Date(timestamp).toISOString().slice(0, 10);
    }
}

module.exports = {
    PerformanceMetricsStore,
    boundedInteger,
};
