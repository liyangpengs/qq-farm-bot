import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};
/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */
export interface AdminContext {
    tokens: Map<string, string>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
}
//# sourceMappingURL=context.d.ts.map