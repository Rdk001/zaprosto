import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminAppointments } from "../../../server/admin/appointments";
import { AdminNavigation } from "../../../components/admin/navigation";
import { AppointmentsError } from "../../../components/admin/appointments-error";
import { LogoutButton } from "../../../components/admin/logout-button";
import { money, time } from "../../../components/booking/format";
import { statusLabels, journalHref } from "../../../modules/appointments/domain/admin-input";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Журнал записей — Запросто",
  robots: { index: false, follow: false },
};
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await getAdminAppointments(await searchParams);
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  if (!result.ok) return <AppointmentsError code={result.code} />;
  const data = result.journal,
    q = data.query;
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell journal-shell">
        <AdminNavigation current="appointments" />
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / ЗАПИСИ</p>
          <h1>Журнал записей</h1>
          <p>
            Часовой пояс бизнеса: <strong>{data.timezone}</strong>. Запись относится к дню её
            начала.
          </p>
        </div>
        <form method="get" action="/admin/appointments" className="journal-filter panel">
          {q.mastersAfter && <input type="hidden" name="mastersAfter" value={q.mastersAfter} />}
          <label className="field">
            Дата визитов
            <input type="date" name="date" defaultValue={q.date} required />
          </label>
          <label className="field">
            Мастер
            <select name="masterId" defaultValue={q.masterId ?? ""}>
              <option value="">Все мастера</option>
              {data.masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.isActive ? "" : " — неактивен"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Статус
            <select name="status" defaultValue={q.status}>
              <option value="ACTIVE">Все, кроме отменённых</option>
              <option value="ALL">Все статусы</option>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary">
            Показать записи
          </button>
        </form>
        {(data.nextMasters || q.mastersAfter) && (
          <nav className="form-footer" aria-label="Страницы выбора мастера">
            {q.mastersAfter && (
              <a href={journalHref({ ...q, mastersAfter: undefined })}>Первые мастера</a>
            )}
            {data.nextMasters && (
              <a href={journalHref({ ...q, mastersAfter: data.nextMasters })}>Следующие мастера</a>
            )}
          </nav>
        )}
        <p className="hint">
          Прошлые и будущие даты доступны независимо от горизонта бронирования. Название, цена и
          длительность — на момент создания записи.
        </p>
        {data.appointments.length ? (
          <ol className="journal-list" aria-label="Записи за выбранный день">
            {data.appointments.map((a) => (
              <li key={a.id} className="panel journal-item">
                <div>
                  <p className="journal-time">
                    {time(a.startsAt, data.timezone)}–{time(a.endsAt, data.timezone)}
                  </p>
                  <p>{statusLabels[a.status]}</p>
                </div>
                <div>
                  <h2>
                    <a href={journalHref(q, a.id)}>{a.serviceNameSnapshot}</a>
                  </h2>
                  <p>
                    {money(a.servicePriceSnapshot)} · {a.serviceDurationSnapshot} мин
                  </p>
                  <p>
                    Мастер: {a.master.name}
                    {a.master.isActive ? "" : " (неактивен)"}
                  </p>
                  <p>Клиент: {a.clientName}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="notice" role="status">
            На этой странице нет записей по выбранным фильтрам.
          </p>
        )}
        <nav className="form-footer" aria-label="Страницы журнала">
          {q.page > 1 && <a href={journalHref({ ...q, page: q.page - 1 })}>Предыдущая страница</a>}
          <span>Страница {q.page}</span>
          {data.hasNext && <a href={journalHref({ ...q, page: q.page + 1 })}>Следующая страница</a>}
        </nav>
        <div className="form-footer">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
