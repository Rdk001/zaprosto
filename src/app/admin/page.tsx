import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminHome } from "../../server/admin";
import { LogoutButton } from "../../components/admin/logout-button";

import { AdminNavigation } from "../../components/admin/navigation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Администратор — Запросто",
  robots: { index: false, follow: false },
};
export default async function AdminPage() {
  const result = await getAdminHome();
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="admin-shell">
        {result.ok ? (
          <>
            <AdminNavigation current="home" />
            <div className="appointment-heading">
              <p className="eyebrow">ЗАПРОСТО / АДМИНИСТРАТОР</p>
              <h1>Вы вошли</h1>
              <p>Административный доступ подтверждён.</p>
            </div>
            <section className="panel" aria-label="Сеанс администратора">
              <p className="admin-login-name">
                Логин: <strong>{result.admin.login}</strong>
              </p>
              <p className="hint">
                Управляйте услугами, мастерами и назначениями через разделы выше. Расписание и
                управление записями появятся на следующих этапах.
              </p>
              <div className="form-footer">
                <LogoutButton />
              </div>
            </section>
          </>
        ) : (
          <>
            <div className="appointment-heading">
              <h1>Доступ временно недоступен</h1>
            </div>
            <p role="alert">Не удалось проверить сеанс. Обновите страницу позже.</p>
          </>
        )}
      </div>
    </main>
  );
}
