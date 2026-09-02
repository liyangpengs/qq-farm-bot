export declare const TARGET_APP_ID = "wx5306c5978fdb76e4";
export declare function putLoginBufferByCode(code: string, loginBuffer: string): void;
export declare function takeLoginBufferByCode(code: string): string;
export declare function reissueWxLoginCode(loginBuffer: string, appId: string): Promise<string>;
export type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';
export interface WxLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    oauthCode?: string;
    openid?: string;
    loginBuffer?: string;
}
export declare class WxLoginService {
    createQrSession(): Promise<{
        session: WxLoginSession;
        qr: Buffer;
    }>;
    poll(session: WxLoginSession): Promise<ScanStatus>;
    confirm(session: WxLoginSession): Promise<{
        openid: string;
        loginBuffer: string;
    }>;
    issueCode(session: WxLoginSession, appId: string): Promise<string>;
    destroy(session: WxLoginSession): void;
}
//# sourceMappingURL=service.d.ts.map