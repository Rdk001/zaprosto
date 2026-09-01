/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation preserves nonce-CSP (ADR-0005). */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminNavigation } from "../../../../components/admin/navigation";
import { AppointmentCreateFlow } from "../../../../components/admin/appointment-create-flow";
import { AppointmentsError } from "../../../../components/admin/appointments-error";
import { getAdminAppointmentCreationForm } from "../../../../server/admin/appointments";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Новая запись — Запросто",
  robots: { index: false, follow: false },
};

export default async function NewAppointmentPage() {
  const result = await getAdminAppointmentCreationForm();
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  if (!result.ok) return <AppointmentsError code={result.code} />;
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell admin-create-shell">
        <AdminNavigation current="appointments" />
        <p>
          <a href="/admin/appointments">Вернуться к журналу</a>
        </p>
        <AppointmentCreateFlow catalog={result.catalog} />
      </div>
    </main>
  );
}
