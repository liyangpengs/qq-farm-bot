export {};
const { getPlantById } = require('../config/gameConfig');
const { getServerTimeSec } = require('../utils/utils');

const SNAPSHOT_MAX_AGE_SEC = 180;
const HISTORY_MIN_SECONDS = 60;
const num = (value: any) => Number(value?.toString?.() ?? value) || 0;
const seconds = (value: any) => num(value) > 1e12 ? Math.floor(num(value) / 1000) : num(value);

interface HarvestEvent { landId: number; at: number; exp: number }

// Count each planted footprint once. Only the current season has a server-supplied maturity time.
function buildHarvestEvents(lands: any[], nowSec: number, getPlant = getPlantById): HarvestEvent[] {
    const events: HarvestEvent[] = [];
    const seen = new Set<number>();
    const slaves = new Set<number>();
    for (const land of lands) for (const id of land.slave_land_ids || []) slaves.add(num(id));
    for (const land of lands) {
        const id = num(land.id); const master = num(land.master_land_id);
        if (!id || seen.has(id) || !land.unlocked || slaves.has(id) || (master && master !== id)) continue;
        seen.add(id);
        const plant = land.plant;
        if (!plant || !Array.isArray(plant.phases)) continue;
        const phases = plant.phases.filter((phase: any) => seconds(phase.begin_time) > 0);
        // The protocol sends a suffix beginning with the current phase; clocks do not advance that state.
        const current = plant.phases[0];
        if (current && (num(current.phase) === 7 || num(current.phase) === 0)) continue;
        const config = getPlant(num(plant.id));
        const configuredPhases = String(config?.grow_phases || '').split(';').filter(Boolean);
        const finalName = configuredPhases.at(-1)?.split(':')[0];
        const explicitMature = phases.find((phase: any) => [6, 19].includes(num(phase.phase)) || num(phase.phase_id) === 19);
        const finalPhase = phases.at(-1);
        const mature = explicitMature || (['成熟', '盛开'].includes(finalName)
            && plant.phases.length <= configuredPhases.length && num(finalPhase?.phase) === 2 ? finalPhase : null);
        if (!mature) continue;
        // Missing server bonus data is unknown, not a zero bonus guessed from the soil colour.
        if (!config || !land.buff || !Number.isFinite(Number(land.buff.plant_exp_bonus))) continue;
        const exp = Math.floor(num(config.exp) * (1 + Math.max(0, num(land.buff.plant_exp_bonus)) / 10000));
        if (exp <= 0) continue;
        events.push({ landId: id, at: Math.max(nowSec, seconds(mature.begin_time)), exp });
    }
    return events.sort((a, b) => a.at - b.at || a.landId - b.landId);
}

function calculateLevelForecast(options: {
    lands?: any[]; nowSec: number; remainingExp: number; historyRate: number;
    connected?: boolean; autoHarvest?: boolean; quiet?: boolean; getPlant?: (id: number) => any;
}) {
    const { nowSec } = options;
    const remainingExp = Math.max(0, num(options.remainingExp));
    const base = { generatedAt: nowSec * 1000, remainingExp, scheduledExp: 0, plotCount: 0, readyExp: 0,
        estimatedAt: null as number | null, source: 'unavailable', automatic: !!options.autoHarvest && !options.quiet };
    if (!options.connected || remainingExp <= 0) return base;
    const events = buildHarvestEvents(options.lands || [], nowSec, options.getPlant);
    base.scheduledExp = events.reduce((sum, event) => sum + event.exp, 0);
    base.plotCount = events.length;
    base.readyExp = events.filter(event => event.at <= nowSec).reduce((sum, event) => sum + event.exp, 0);
    let total = 0;
    for (const event of events) {
        total += event.exp;
        if (total >= remainingExp) return { ...base, source: event.at <= nowSec ? 'ready' : 'planted', estimatedAt: event.at * 1000 };
    }
    // Do not count the same past farm harvest rate alongside scheduled harvests.
    // Extend the remaining gap only after the last known harvest, as a separate historical estimate.
    const rate = Math.max(0, num(options.historyRate));
    if (rate <= 0 || !base.automatic) return base;
    const startAt = events.length ? events[events.length - 1].at : nowSec;
    const estimatedAt = (startAt + Math.ceil((remainingExp - total) / rate * 3600)) * 1000;
    return { ...base, source: events.length ? 'mixed' : 'history', estimatedAt };
}

let revision = 0;
let snapshot: { lands: any[]; gid: number; exp: number; at: number } | null = null;
function invalidateLandForecast() { snapshot = null; revision++; }
function getLandForecastRevision() { return revision; }
function rememberLandForecast(lands: any[], user: any, expectedRevision: number) {
    if (revision !== expectedRevision || !Array.isArray(lands)) return;
    snapshot = { lands, gid: num(user.gid), exp: num(user.exp), at: getServerTimeSec() };
}
function getLevelForecast(user: any, progress: any, stats: any, automation: any, quiet: boolean) {
    const nowSec = getServerTimeSec();
    const valid = snapshot && snapshot.gid === num(user.gid) && snapshot.exp === num(user.exp)
        && nowSec >= snapshot.at && nowSec - snapshot.at <= SNAPSHOT_MAX_AGE_SEC;
    const sessionSeconds = Math.max(0, num(stats.sessionElapsedSeconds));
    return calculateLevelForecast({ lands: valid ? snapshot.lands : [], nowSec,
        remainingExp: progress ? num(progress.needed) - num(progress.current) : 0,
        historyRate: sessionSeconds >= HISTORY_MIN_SECONDS ? Math.max(0, num(stats.sessionExpGained)) / sessionSeconds * 3600 : 0,
        connected: !!stats.connection?.connected, autoHarvest: !!automation?.farm, quiet });
}

module.exports = { buildHarvestEvents, calculateLevelForecast, invalidateLandForecast, getLandForecastRevision, rememberLandForecast, getLevelForecast };
