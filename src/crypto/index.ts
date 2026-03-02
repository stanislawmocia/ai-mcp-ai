import sodium from "libsodium-wrappers";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { keypairs } from "../db/index.js";

let _initialized = false;
let _publicKey: Uint8Array | null = null;
let _secretKey: Uint8Array | null = null;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Derive an AES-256 key from passphrase + salt using PBKDF2
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 100_000, 32, "sha256");
}

/**
 * Encrypt data with AES-256-GCM using derived key
 */
function aesEncrypt(data: Buffer, passphrase: string): { ciphertext: string; salt: string; iv: string; tag: string } {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt AES-256-GCM encrypted data
 */
function aesDecrypt(encrypted: { ciphertext: string; salt: string; iv: string; tag: string }, passphrase: string): Buffer {
  const salt = Buffer.from(encrypted.salt, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const key = deriveKey(passphrase, salt);
  const tag = Buffer.from(encrypted.tag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function initCrypto(): Promise<KeyPair> {
  if (_initialized && _publicKey && _secretKey) {
    return { publicKey: _publicKey, secretKey: _secretKey };
  }

  await sodium.ready;

  const passphrase = process.env.MCP_COMM_KEY_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      "MCP_COMM_KEY_PASSPHRASE environment variable is required for key encryption. " +
      "Set it to a strong passphrase to protect your private key."
    );
  }

  const existing = keypairs.get();

  if (existing) {
    // Decrypt existing secret key
    try {
      const encrypted = JSON.parse(
        Buffer.from(existing.secret_key, "base64").toString("utf-8")
      ) as { ciphertext: string; salt: string; iv: string; tag: string };

      const decryptedKey = aesDecrypt(encrypted, passphrase);
      _secretKey = new Uint8Array(decryptedKey);
      _publicKey = sodium.from_base64(existing.public_key, sodium.base64_variants.ORIGINAL);

      console.error("[crypto] Loaded existing keypair from DB");
    } catch (err) {
      throw new Error(`Failed to decrypt secret key - wrong passphrase? ${err}`);
    }
  } else {
    // Generate new keypair
    const keypair = sodium.crypto_box_keypair();
    _publicKey = keypair.publicKey;
    _secretKey = keypair.privateKey;

    const pubKeyB64 = sodium.to_base64(_publicKey, sodium.base64_variants.ORIGINAL);

    // Encrypt secret key with AES-256-GCM
    const encrypted = aesEncrypt(Buffer.from(_secretKey), passphrase);
    const encryptedB64 = Buffer.from(JSON.stringify(encrypted)).toString("base64");

    keypairs.save(pubKeyB64, encryptedB64, "aes-gcm");
    console.error(`[crypto] Generated new keypair. Public key: ${pubKeyB64.slice(0, 16)}...`);
  }

  _initialized = true;
  return { publicKey: _publicKey!, secretKey: _secretKey! };
}

export function getPublicKeyBase64(): string {
  if (!_publicKey) {
    throw new Error("Crypto not initialized");
  }
  return sodium.to_base64(_publicKey, sodium.base64_variants.ORIGINAL);
}

export function encryptMessage(
  message: string,
  recipientPublicKeyB64: string,
): { encryptedContent: string; nonce: string } {
  if (!_secretKey) {
    throw new Error("Crypto not initialized");
  }

  const recipientPublicKey = sodium.from_base64(recipientPublicKeyB64, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

  const encrypted = sodium.crypto_box_easy(
    sodium.from_string(message),
    nonce,
    recipientPublicKey,
    _secretKey
  );

  return {
    encryptedContent: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

export function decryptMessage(
  encryptedContentB64: string,
  nonceB64: string,
  senderPublicKeyB64: string,
): string {
  if (!_secretKey) {
    throw new Error("Crypto not initialized");
  }

  const encryptedContent = sodium.from_base64(encryptedContentB64, sodium.base64_variants.ORIGINAL);
  const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
  const senderPublicKey = sodium.from_base64(senderPublicKeyB64, sodium.base64_variants.ORIGINAL);

  const decrypted = sodium.crypto_box_open_easy(
    encryptedContent,
    nonce,
    senderPublicKey,
    _secretKey
  );

  if (!decrypted) {
    throw new Error("Decryption failed - message may be corrupted or sender key is wrong");
  }

  return sodium.to_string(decrypted);
}
