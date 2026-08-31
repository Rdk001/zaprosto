import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminSettings } from "../../../server/admin/settings";
import { AdminNavigation } from "../../../components/admin/navigation";
import { SettingsEditor } from "../../../components/admin/settings-editor";
import { LogoutButton } from "../../../components/admin/logout-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Настройки времени — Запросто",
  robots: { index: false, follow: false },
};
export default async function SettingsPage() {
  const result = await getAdminSettings();
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell settings-shell">
        <AdminNavigation current="settings" />
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / НАСТРОЙКИ</p>
          <h1>Время и запись</h1>
          <p>Часовой пояс бизнеса и доступные для новой записи даты.</p>
        </div>
        {result.ok ? (
          <SettingsEditor initial={result.settings} />
        ) : (
          <div className="panel">
            <p role="alert">
              Не удалось проверить сеанс или прочитать настройки. Данные не изменены.
            </p>
            <a href="/admin/settings">Повторить чтение настроек</a>
          </div>
        )}
        <div className="form-footer">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
