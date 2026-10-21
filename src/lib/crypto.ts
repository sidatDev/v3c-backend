import crypto from 'crypto';

const DEV_FALLBACK_KEY = 'v3c_default_dev_encryption_master_key_32b!';
let warnedMissingKey = false;

/**
 * Derives a consistent 32-byte (256-bit) buffer key for AES-256-GCM.
 */
export const getMasterKeyBuffer = (explicitKey?: string): Buffer => {
  const rawKey = explicitKey || process.env.ENCRYPTION_MASTER_KEY;

  if (!rawKey) {
    if (!warnedMissingKey) {
      console.warn('[SECURITY WARNING] ENCRYPTION_MASTER_KEY is not defined in environment. Using insecure development fallback key.');
      warnedMissingKey = true;
    }
    return crypto.createHash('sha256').update(DEV_FALLBACK_KEY).digest();
  }

  // Derive exactly 32 bytes using SHA-256 to support both hex strings and arbitrary passphrases
  return crypto.createHash('sha256').update(rawKey).digest();
};

export interface EncryptedPayload {
  encryptedValue: string; // hex-encoded ciphertext
  iv: string;             // hex-encoded 12-byte IV
  authTag: string;        // hex-encoded 16-byte authentication tag
}

/**
 * Encrypts plaintext using AES-256-GCM (Envelope Encryption).
 */
export const encrypt = (plaintext: string, masterKey?: string): EncryptedPayload => {
  const keyBuffer = getMasterKeyBuffer(masterKey);
  const ivBuffer = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, ivBuffer);
  const encryptedBuffer = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTagBuffer = cipher.getAuthTag();

  return {
    encryptedValue: encryptedBuffer.toString('hex'),
    iv: ivBuffer.toString('hex'),
    authTag: authTagBuffer.toString('hex'),
  };
};

/**
 * Decrypts AES-256-GCM ciphertext using the given IV and AuthTag.
 */
export const decrypt = (
  ciphertext: string,
  iv: string,
  authTag: string,
  masterKey?: string
): string => {
  const keyBuffer = getMasterKeyBuffer(masterKey);
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(authTag, 'hex');
  const encryptedBuffer = Buffer.from(ciphertext, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  const decryptedBuffer = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final()
  ]);

  return decryptedBuffer.toString('utf8');
};
