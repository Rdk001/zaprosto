"use server";

import { cookies, headers } from "next/headers";

import { sessionCookie } from "../../modules/auth/policy";
import { adminTelegram } from "../../server/admin/telegram";

async function currentSessionToken() {
  const options = sessionCookie();
  return (await cookies()).get(options.name)?.value;
}

export async function getAdminTelegramStateAction() {
  try {
    return await adminTelegram.state(await currentSessionToken());
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

export async function issueAdminTelegramLinkAction() {
  try {
    return await adminTelegram.issue(await headers(), await currentSessionToken());
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

export async function revokeAdminTelegramLinkAction() {
  try {
    return await adminTelegram.revoke(await headers(), await currentSessionToken());
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}

export async function disconnectAdminTelegramAction() {
  try {
    return await adminTelegram.disconnect(await headers(), await currentSessionToken());
  } catch {
    return { ok: false as const, code: "UNAVAILABLE" as const };
  }
}
