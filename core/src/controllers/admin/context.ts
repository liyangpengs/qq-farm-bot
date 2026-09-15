import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminSession {
    token: string;
    username: string;
    role: string;
    card?: any;
    qq?: string;
    accountLimit?: number;
    mustChangePassword?: boolean;
    createdAt: number;
}

export interface AdminContext {
    tokens: Map<string, AdminSession>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
    captureCore?: any;
}

function createAdminContext(dataProvider: any): AdminContext {
    const tokens = new Map<string, AdminSession>();
    return {
        tokens,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
        captureCore: null,
    };
}

module.exports = { createAdminContext };
