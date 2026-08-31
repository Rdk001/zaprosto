/* Full document links preserve the nonce-CSP navigation policy of 05.1. */
export function AdminNavigation({ current }: { current: "home" | "services" | "masters" }) {
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
    </nav>
  );
}
