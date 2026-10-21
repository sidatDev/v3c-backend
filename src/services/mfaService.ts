import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

export interface MfaSetupResult {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

/**
 * Generate a new TOTP secret and QR code for MFA setup.
 */
export const generateMfaSetup = async (email: string): Promise<MfaSetupResult> => {
  const secret = new OTPAuth.Secret({ size: 20 });
  
  const totp = new OTPAuth.TOTP({
    issuer: 'V3C',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  const otpauthUrl = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return {
    secret: secret.base32,
    otpauthUrl,
    qrCodeDataUrl,
  };
};

/**
 * Verify a 6-digit TOTP code against a secret.
 */
export const verifyMfaCode = (secretStr: string, token: string): boolean => {
  try {
    const totp = new OTPAuth.TOTP({
      issuer: 'V3C',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretStr),
    });

    // delta returns null if invalid, or an integer offset if valid (window: 1 allows +/- 30s)
    const delta = totp.validate({ token: token.trim(), window: 1 });
    return delta !== null;
  } catch (err: any) {
    console.error('[MFA VERIFICATION ERROR]:', err?.message || err);
    return false;
  }
};
