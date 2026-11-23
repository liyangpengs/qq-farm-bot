import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import type { PersistentTokenSet } from './session-tokens';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

const { createPersistentTokenSet } = require('./session-tokens');

export interface AdminContext {
    tokens: Set<string> | PersistentTokenSet;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = createPersistentTokenSet();
    return {
        tokens,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}

module.exports = { createAdminContext };
