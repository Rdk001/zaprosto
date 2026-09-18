import type { AdminTelegramHealthResult } from "./telegram-health-boundary";

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
} as const;

function response(result: AdminTelegramHealthResult): Response {
  if (result.ok) {
    return Response.json(result, { status: 200, headers: RESPONSE_HEADERS });
  }
  const status = result.code === "UNAUTHORIZED" ? 401 : 503;
  return Response.json(result, { status, headers: RESPONSE_HEADERS });
}

export function createAdminTelegramHealthRouteHandler(dependencies: {
  sessionToken: () => Promise<unknown>;
  read: (sessionToken: unknown) => Promise<AdminTelegramHealthResult>;
}) {
  return async function GET(): Promise<Response> {
    try {
      return response(await dependencies.read(await dependencies.sessionToken()));
    } catch {
      return response({ ok: false, code: "UNAVAILABLE" });
    }
  };
}
