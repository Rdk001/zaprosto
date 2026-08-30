import { connection } from "next/server";
import { AppointmentView } from "../../components/booking/appointment-view";
export const metadata = {
  title: "Ваша запись — Запросто",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer" as const,
};
export default async function AppointmentPage() {
  await connection();
  // Fragment secret is never part of the HTTP request or RSC props.
  return (
    <main id="main" tabIndex={-1} className="shell">
      <AppointmentView />
    </main>
  );
}
