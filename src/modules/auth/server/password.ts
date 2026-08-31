import { randomBytes } from "node:crypto";
import { argon2id, hash, verify } from "argon2";
import { passwordSchema } from "../policy";

export const ARGON_OPTIONS = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;
export async function hashPassword(password: string) {
  passwordSchema.parse(password);
  return hash(password, ARGON_OPTIONS);
}

let dummyHash: Promise<string> | undefined;
export async function verifyPassword(password: string, storedHash?: string) {
  // Unknown users pay the same Argon2 cost. The dummy is random and never an account.
  dummyHash ??= hash(randomBytes(32), ARGON_OPTIONS);
  const fallback = await dummyHash;
  try {
    return await verify(storedHash ?? fallback, password);
  } catch {
    // A damaged DB hash must neither expose details nor produce a cheap timing path.
    await verify(fallback, password);
    return false;
  }
}
