import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'v3c-super-secret-jwt-key-2026';

export interface TokenPayload {
  userId: number;
  tenantId: string | null;
  role: string;
  permissions: string[];
}

export const signToken = (payload: TokenPayload, rememberMe: boolean = false): string => {
  const expiresIn = rememberMe ? '30d' : '24h';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

export const verifyToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
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
