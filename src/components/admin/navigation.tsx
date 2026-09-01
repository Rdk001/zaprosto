/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation preserves nonce-CSP (ADR-0005). */
/* Full document links preserve the nonce-CSP navigation policy of 05.1. */
export function AdminNavigation({
  current,
}: {
  current: "home" | "services" | "masters" | "schedule" | "settings" | "appointments";
}) {
  return (
    <nav className="admin-nav" aria-label="Административные разделы">
      <a href="/admin" aria-current={current === "home" ? "page" : undefined}>
        Обзор
      </a>
      <a href="/admin/services" aria-current={current === "services" ? "page" : undefined}>
        Услуги
      </a>
      <a href="/admin/masters" aria-current={current === "masters" ? "page" : undefined}>
        Мастера
      </a>
      <a href="/admin/schedule" aria-current={current === "schedule" ? "page" : undefined}>
        Расписание
      </a>
      <a href="/admin/appointments" aria-current={current === "appointments" ? "page" : undefined}>
        Записи
      </a>
      <a href="/admin/settings" aria-current={current === "settings" ? "page" : undefined}>
        Настройки
      </a>
    </nav>
  );
}
