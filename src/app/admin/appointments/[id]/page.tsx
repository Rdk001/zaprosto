import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminAppointment } from "../../../../server/admin/appointments";
import { AdminNavigation } from "../../../../components/admin/navigation";
import { AppointmentsError } from "../../../../components/admin/appointments-error";
import { AppointmentContactEditor } from "../../../../components/admin/appointment-contact-editor";
import { AppointmentRescheduleEditor } from "../../../../components/admin/appointment-reschedule-editor";
import { AppointmentStatusEditor } from "../../../../components/admin/appointment-status-editor";
import { LogoutButton } from "../../../../components/admin/logout-button";
import { money, dateTime } from "../../../../components/booking/format";
import {
  actorLabels,
  sourceLabels,
  statusLabels,
  journalHref,
} from "../../../../modules/appointments/domain/admin-input";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Карточка записи — Запросто",
  robots: { index: false, follow: false },
};
export default async function AppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await getAdminAppointment((await params).id, await searchParams);
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  if (!result.ok) return <AppointmentsError code={result.code} />;
  const data = result.detail,
    a = data.appointment,
    q = data.query;
  const href = journalHref(q, a.id, q.historyPage);
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell appointment-detail-shell">
        <AdminNavigation current="appointments" />
        <p>
          <a href={journalHref(q)}>Вернуться к журналу</a>
        </p>
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / ЗАПИСЬ</p>
          <h1>Карточка записи</h1>
          <p>
            Часовой пояс бизнеса: <strong>{data.timezone}</strong>
          </p>
        </div>
        <section className="panel" aria-labelledby="visit-title">
          <h2 id="visit-title">Сведения о визите</h2>
          <dl className="appointment-facts">
            <div>
              <dt>Начало</dt>
              <dd>{dateTime(a.startsAt, data.timezone)}</dd>
            </div>
            <div>
              <dt>Окончание</dt>
              <dd>{dateTime(a.endsAt, data.timezone)}</dd>
            </div>
            <div>
              <dt>Мастер</dt>
              <dd>
                {a.master.name}
                {a.master.isActive ? "" : " (неактивен)"}
              </dd>
            </div>
            <div>
              <dt>Услуга при записи</dt>
              <dd>
                {a.serviceNameSnapshot} · {money(a.servicePriceSnapshot)} ·{" "}
                {a.serviceDurationSnapshot} мин
              </dd>
            </div>
            <div>
              <dt>Клиент</dt>
              <dd>{a.clientName}</dd>
            </div>
            <div>
              <dt>Телефон</dt>
              <dd>{a.clientPhone}</dd>
            </div>
            <div>
              <dt>Источник создания</dt>
              <dd>{sourceLabels[a.source]}</dd>
            </div>
          </dl>
        </section>
        {a.status === "SCHEDULED" && data.reschedule ? (
          <AppointmentRescheduleEditor
            appointment={{
              id: a.id,
              version: a.version,
              serviceId: a.serviceId,
              masterId: a.masterId,
              masterSelection: a.masterSelection,
              startsAt: a.startsAt.toISOString(),
              endsAt: a.endsAt.toISOString(),
              serviceNameSnapshot: a.serviceNameSnapshot,
              servicePriceSnapshot: a.servicePriceSnapshot,
              serviceDurationSnapshot: a.serviceDurationSnapshot,
              master: { name: a.master.name },
            }}
            form={{
              context: {
                contextHash: data.reschedule.catalog.context.contextHash,
                timeZone: data.reschedule.catalog.context.timeZone,
                dates: data.reschedule.catalog.context.dates,
              },
              services: data.reschedule.catalog.services.map((service) => ({
                id: service.id,
                name: service.name,
                priceKopecks: service.priceKopecks,
                durationMinutes: service.durationMinutes,
                termsHash: service.termsHash,
                masters: service.masters.map((master) => ({ id: master.id, name: master.name })),
              })),
              historicalMasters: data.reschedule.historicalMasters,
            }}
            href={href}
            saved={q.visitUpdated === "1"}
          />
        ) : (
          <section className="panel" aria-labelledby="visit-parameters-title">
            <h2 id="visit-parameters-title">Параметры визита</h2>
            {a.status === "CANCELLED" ? (
              <p>
                Отменённая запись хранится как единое историческое состояние. Параметры визита и
                контакты не редактируются.
              </p>
            ) : a.status === "COMPLETED" || a.status === "NO_SHOW" ? (
              <p>
                Параметры завершённого визита больше не редактируются. Исправление имени и телефона
                клиента остаётся доступно отдельно.
              </p>
            ) : (
              <p>Редактор параметров визита сейчас недоступен. Полностью перечитайте карточку.</p>
            )}
          </section>
        )}
        {a.status === "CANCELLED" ? (
          <section className="panel" aria-labelledby="contacts-title">
            <h2 id="contacts-title">Имя и телефон клиента</h2>
            <p>Отменённая запись хранится как историческая и не редактируется.</p>
          </section>
        ) : (
          <AppointmentContactEditor
            id={a.id}
            version={a.version}
            clientName={a.clientName}
            clientPhone={a.clientPhone}
            href={href}
            saved={q.contactsUpdated === "1"}
          />
        )}
        <AppointmentStatusEditor
          id={a.id}
          version={a.version}
          status={a.status}
          businessContext={data.businessContext}
          href={href}
        />
        {a.cancelledAt && (
          <section className="panel" aria-labelledby="cancel-title">
            <h2 id="cancel-title">Сведения об отмене</h2>
            <p>
              {dateTime(a.cancelledAt, data.timezone)} ·{" "}
              {a.cancelledBy ? actorLabels[a.cancelledBy] : "Инициатор не указан"}
            </p>
            <p className="saved-reason">{a.cancellationReason || "Причина не указана"}</p>
            <p className="notice">
              Автоматические уведомления ещё не реализованы. Если отменил администратор, нужно
              самостоятельно связаться с клиентом.
            </p>
          </section>
        )}
        <section className="panel" aria-labelledby="history-title">
          <h2 id="history-title">История статусов</h2>
          {data.history.length ? (
            <ol className="status-history">
              {data.history.map((h) => (
                <li key={h.id}>
                  <p>
                    <strong>
                      {h.previousStatus ? statusLabels[h.previousStatus] : "Создание"} →{" "}
                      {statusLabels[h.newStatus]}
                    </strong>
                  </p>
                  <p>
                    {dateTime(h.changedAt, data.timezone)} · {actorLabels[h.changedBy]}
                  </p>
                  {h.changedByAdminId && (
                    <p className="hint">ID администратора: {h.changedByAdminId}</p>
                  )}
                  <p className="saved-reason">{h.reason || "Причина не указана"}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p>На этой странице истории нет событий.</p>
          )}
          <nav className="form-footer" aria-label="Страницы истории">
            {q.historyPage > 1 && (
              <a href={journalHref(q, a.id, q.historyPage - 1)}>Предыдущие события</a>
            )}
            <span>Страница истории {q.historyPage}</span>
            {data.hasNextHistory && (
              <a href={journalHref(q, a.id, q.historyPage + 1)}>Следующие события</a>
            )}
          </nav>
        </section>
        <div className="form-footer">
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
