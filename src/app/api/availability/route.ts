import { publicBooking } from "../../../server/public";
export async function GET(request: Request) {
  const result = await publicBooking.availability(
    request.headers,
    Object.fromEntries(new URL(request.url).searchParams),
  );
  const status = result.ok
    ? 200
    : result.code === "RATE_LIMITED"
      ? 429
      : result.code === "UNAVAILABLE"
        ? 503
        : 400;
  return Response.json(result, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
}
