import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, sessionSecret } from "./config.js";
import { store, type User } from "./store.js";

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;
const COOKIE = "amdl_session";

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
    const useSalt = salt ?? crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, useSalt, KEYLEN, SCRYPT).toString("hex");
    return { hash, salt: useSalt };
}

export function verifyPassword(user: User, password: string): boolean {
    const { hash } = hashPassword(password, user.salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(user.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(payload: string): string {
    return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

export function issueSession(res: Response, user: User): void {
    const exp = Date.now() + config.sessionDays * 86_400_000;
    const payload = `${user.id}.${exp}`;
    const value = `${payload}.${sign(payload)}`;
    res.cookie(COOKIE, value, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: config.sessionDays * 86_400_000,
        path: "/"
    });
}

export function clearSession(res: Response): void {
    res.clearCookie(COOKIE, { path: "/" });
}

/** Minimal cookie reader — avoids depending on cookie-parser. */
function readCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return undefined;
}

export function currentUser(req: Request): User | undefined {
    const raw = readCookie(req, COOKIE);
    if (!raw) return undefined;
    const parts = raw.split(".");
    if (parts.length !== 3) return undefined;
    const [idRaw, expRaw, sig] = parts as [string, string, string];
    const payload = `${idRaw}.${expRaw}`;
    const expected = sign(payload);
    if (sig.length !== expected.length) return undefined;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < Date.now()) return undefined;
    return store.userById(Number(idRaw));
}

/** Attaches res.locals.user for every request. */
export function attachUser(req: Request, res: Response, next: NextFunction): void {
    res.locals.user = currentUser(req);
    next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!res.locals.user) {
        if (req.path.startsWith("/api/")) {
            res.status(401).json({ error: "unauthorized" });
        } else {
            res.redirect("/login");
        }
        return;
    }
    next();
}

/** Seeds the first admin from ADMIN_USER/ADMIN_PASSWORD when configured. */
export function seedAdmin(): void {
    if (!config.adminUser || !config.adminPassword) return;
    const existing = store.userByName(config.adminUser);
    const { hash, salt } = hashPassword(config.adminPassword);
    if (!existing) {
        store.addUser(config.adminUser, hash, salt);
        console.log(`[auth] seeded admin user "${config.adminUser}"`);
    } else {
        store.setPassword(existing.id, hash, salt);
    }
}
