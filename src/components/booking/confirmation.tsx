"use client";
import { useState } from "react";
import type { AppointmentConfirmation } from "../../modules/appointments/server/confirmation";
import { dateTime, money } from "./format";
export const statusLabels = {
  SCHEDULED: "Запланирована",
  CANCELLED: "Отменена",
  COMPLETED: "Выполнена",
  NO_SHOW: "Клиент не пришёл",
};
export function Confirmation({
  confirmation: c,
  timeZone,
  token,
}: {
  confirmation: AppointmentConfirmation;
  timeZone: string;
  token: string;
}) {
  const [copy, setCopy] = useState("");
  const href = "/appointment#" + token;
  return (
    <section className="ticket" aria-label="Подтверждение записи">
      <div className="ticket-top">
        <span className="eyebrow">Ваша запись</span>
        <span className={"badge " + (c.status === "CANCELLED" ? "muted" : "")}>
          {statusLabels[c.status]}
        </span>
      </div>
      <h2>{c.service.name}</h2>
      <p className="visit-date">{dateTime(c.startsAt, timeZone)}</p>
      <dl className="details">
        <div>
          <dt>Мастер</dt>
          <dd>{c.master.name}</dd>
        </div>
        <div>
          <dt>Длительность</dt>
          <dd>{c.service.durationMinutes} мин</dd>
        </div>
        <div>
          <dt>Стоимость</dt>
          <dd>{money(c.service.priceKopecks)}</dd>
        </div>
        <div>
          <dt>Клиент</dt>
          <dd>{c.clientName}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>{c.clientPhone}</dd>
        </div>
      </dl>
      {c.status === "CANCELLED" && (
        <p className="notice">
          Запись отменена. {c.cancellationReason && <>Причина: {c.cancellationReason}</>}
        </p>
      )}
      <p className="hint">Время указано в часовом поясе {timeZone}.</p>
      <div className="link-box">
        <strong>Сохраните защищённую ссылку</strong>
        <p>По ней можно проверить запись или отменить визит. Не передавайте её посторонним.</p>
        <a href={href} referrerPolicy="no-referrer">
          Открыть мою запись ↗
        </a>
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(window.location.origin + href);
              setCopy("Ссылка скопирована");
            } catch {
              setCopy(
                "Не удалось скопировать. Нажмите и удерживайте ссылку, чтобы скопировать её вручную.",
              );
            }
          }}
        >
          Копировать ссылку
        </button>
        <p role="status">{copy}</p>
      </div>
    </section>
  );
}
