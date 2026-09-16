import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminTelegramControls } from "../../../components/admin/admin-telegram-controls";
import { LogoutButton } from "../../../components/admin/logout-button";
import { AdminNavigation } from "../../../components/admin/navigation";
import { getAdminTelegramState } from "../../../server/admin/telegram";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Уведомления — Запросто",
  robots: { index: false, follow: false },
};

export default async function AdminNotificationsPage() {
  const result = await getAdminTelegramState();
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");

  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell settings-shell">
        <AdminNavigation current="notifications" />
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / УВЕДОМЛЕНИЯ</p>
          <h1>Уведомления</h1>
          <p>Подключите свой Telegram для административных уведомлений.</p>
        </div>
        <AdminTelegramControls
          initialState={result.ok ? result.state : null}
          initialReadFailed={!result.ok}
        />
        <div className="form-footer">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
