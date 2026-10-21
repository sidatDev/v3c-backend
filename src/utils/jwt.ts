import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'v3c-super-secret-jwt-key-2026';

export interface TokenPayload {
  userId: number;
  id?: number;
  email?: string;
  name?: string;
  tenantId: string | null;
  activeTenantId?: string | null;
  groupId?: string | null;
  departmentId?: string | null;
  role: string;
  roleLevel?: string | null;
  permissions: string[];
}

export const signToken = (payload: TokenPayload, rememberMe: boolean = false): string => {
  const expiresIn = rememberMe ? '24h' : '1h'; // Short-lived access token
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

export const verifyToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
};

export interface TempMfaTokenPayload {
  userId: number;
  email: string;
  isMfaPending: true;
}

export const signTempMfaToken = (userId: number, email: string): string => {
  return jwt.sign({ userId, email, isMfaPending: true }, JWT_SECRET, { expiresIn: '5m' });
};

export const verifyTempMfaToken = (token: string): TempMfaTokenPayload => {
  return jwt.verify(token, JWT_SECRET) as TempMfaTokenPayload;
};


export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
  path: string;
}

export const getCookieOptions = (rememberMe: boolean = false): CookieOptions => {
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 days or 1 day
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/'
  };
};
