import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminSchedule } from "../../../server/admin/schedule";
import { AdminNavigation } from "../../../components/admin/navigation";
import { LogoutButton } from "../../../components/admin/logout-button";
import { ScheduleEditor } from "../../../components/admin/schedule-editor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Расписание — Запросто",
  robots: { index: false, follow: false },
};
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const result = await getAdminSchedule(query);
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  if (!result.ok)
    return (
      <main id="main" tabIndex={-1} className="shell">
        <div className="catalog-shell">
          <h1>Расписание недоступно</h1>
          <p role="alert">
            {result.code === "INVALID_INPUT"
              ? "Проверьте мастера и месяц в адресе страницы."
              : result.code === "NOT_FOUND"
                ? "Мастер не найден."
                : result.code === "LIMIT_EXCEEDED"
                  ? "Сохранённые данные превышают предел редактора. Обратитесь к оператору; данные не обрезаны."
                  : "Не удалось проверить сеанс или прочитать расписание. Повторите чтение позже."}
          </p>
          <a href="/admin/schedule">Открыть расписание заново</a>
        </div>
      </main>
    );
  const data = result.schedule;
  const choices = [...data.masters];
  if (data.selected && !choices.some((m) => m.id === data.selected!.id))
    choices.unshift(data.selected);
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell">
        <AdminNavigation current="schedule" />
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / РАСПИСАНИЕ</p>
          <h1>Расписание мастера</h1>
          <p>
            Часовой пояс бизнеса: <strong>{data.timezone}</strong>. Все даты и часы вводятся в этой
            зоне.
          </p>
        </div>
        {choices.length ? (
          <form method="get" action="/admin/schedule" className="schedule-filter">
            <input type="hidden" name="month" value={data.month} />
            <label className="field">
              <span>Мастер</span>
              <select name="masterId" defaultValue={data.selected?.id}>
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.isActive ? "" : " — неактивен"}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="secondary">
              Открыть график
            </button>
          </form>
        ) : (
          <p className="notice">
            Мастеров на этой странице нет. <a href="/admin/masters">Перейти к мастерам</a>
          </p>
        )}
        {data.nextAfter && (
          <p>
            <a href={`/admin/schedule?after=${data.nextAfter}&month=${data.month}`}>
              Следующие мастера
            </a>
          </p>
        )}
        {query.after && (
          <p>
            <a href={`/admin/schedule?month=${data.month}`}>В начало списка мастеров</a>
          </p>
        )}
        {data.selected && (
          <>
            <h2 className="schedule-master">
              {data.selected.name} · {data.selected.isActive ? "Активен" : "Неактивен"}
            </h2>
            <p className="hint">
              Изменение графика не активирует мастера и не назначает ему услуги. Новый мастер
              начинает с пустого графика.
            </p>
            <p className="notice">
              Изменения влияют на новые онлайн-записи. Уже созданные записи не отменяются, не
              переносятся и не изменяются, даже если их время закрыть.
            </p>
            <ScheduleEditor initial={{ ...data, selected: data.selected }} />
          </>
        )}
        <div className="form-footer">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
