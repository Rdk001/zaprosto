import { cookies } from "next/headers";

import { sessionCookie } from "../../../../../modules/auth/policy";
import { adminTelegramHealth } from "../../../../../server/admin/telegram-health";
import { createAdminTelegramHealthRouteHandler } from "../../../../../server/admin/telegram-health-route";

export const dynamic = "force-dynamic";

const handler = createAdminTelegramHealthRouteHandler({
  sessionToken: async () => (await cookies()).get(sessionCookie().name)?.value,
  read: (sessionToken) => adminTelegramHealth.read(sessionToken),
});

export async function GET(): Promise<Response> {
  return handler();
}
