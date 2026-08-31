"use client";
import { useRef, useState, useTransition } from "react";
import { saveSettingsAction } from "../../app/admin/settings-actions";
import type { BusinessTimeSettings } from "../../modules/settings/server/context";
import type { SettingsFailure } from "../../modules/settings/domain/input";

const messages: Record<SettingsFailure["code"], string> = {
  INVALID_INPUT: "Проверьте поля формы. Изменения не сохранены.",
  CONFLICT:
    "Настройки уже изменились. Черновик сохранён здесь. Сверьте актуальные данные в новой вкладке; затем внесите изменения в свежую форму.",
  CONFIRMATION_REQUIRED: "Подтвердите последствия смены часового пояса.",
  UNAUTHORIZED: "Сеанс завершён или доступ отключён. Войдите в другой вкладке и сверьте настройки.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по основному адресу.",
  UNAVAILABLE:
    "Сохранение не подтверждено. Результат неизвестен. Черновик остаётся здесь. Не повторяйте запрос: проверьте актуальные настройки отдельно.",
};
export function SettingsEditor({ initial }: { initial: BusinessTimeSettings }) {
  const [saved, setSaved] = useState(initial);
  const [horizon, setHorizon] = useState(String(initial.bookingHorizonDays));
  const [timezone, setTimezone] = useState(initial.timezone);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<SettingsFailure | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const status = useRef<HTMLDivElement>(null);
  const changedZone = timezone !== saved.timezone;
  const blocked = !!failure && !["INVALID_INPUT", "CONFIRMATION_REQUIRED"].includes(failure.code);
  return (
    <form
      className="panel admin-form"
      noValidate
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current || blocked) return;
        busy.current = true;
        setFailure(null);
        setMessage("");
        startTransition(async () => {
          try {
            const result = await saveSettingsAction({
              version: saved.version,
              bookingHorizonDays: horizon,
              timezone,
              confirmedTimezoneChange: confirmed,
            });
            if (result.ok) {
              setSaved(result.settings);
              setConfirmed(false);
              setMessage("Настройки сохранены. Новые расчёты используют эти значения.");
            } else setFailure(result);
          } catch {
            setFailure({ ok: false, code: "UNAVAILABLE" });
          } finally {
            busy.current = false;
            requestAnimationFrame(() => status.current?.focus());
          }
        });
      }}
    >
      <fieldset className="catalog-fields" disabled={pending}>
        <legend className="schedule-title">Настройки бронирования</legend>
        <label className="field" htmlFor="settings-horizon">
          Горизонт бронирования, дней
          <input
            id="settings-horizon"
            type="text"
            inputMode="numeric"
            maxLength={2}
            value={horizon}
            onChange={(e) => {
              setHorizon(e.target.value);
              setMessage("");
            }}
            aria-invalid={!!failure?.fields?.bookingHorizonDays}
            aria-describedby="horizon-hint horizon-error"
          />
        </label>
        <p id="horizon-hint" className="hint">
          От 7 до 90 локальных календарных дней, включая сегодня. Сокращение ограничит новые записи;
          уже созданные визиты останутся доступны для просмотра и отмены.
        </p>
        <p id="horizon-error" className="field-error">
          {failure?.fields?.bookingHorizonDays}
        </p>
        <label className="field" htmlFor="settings-timezone">
          Часовой пояс бизнеса
          <input
            id="settings-timezone"
            type="text"
            maxLength={100}
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setConfirmed(false);
              setMessage("");
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!failure?.fields?.timezone}
            aria-describedby="timezone-hint timezone-error"
          />
        </label>
        <p id="timezone-hint" className="hint">
          Именованная зона IANA, например Europe/Moscow, Asia/Yekaterinburg или Europe/Berlin.
          Смещение вроде +03:00 не подходит. Все даты и время показываются в зоне бизнеса.
        </p>
        <p id="timezone-error" className="field-error">
          {failure?.fields?.timezone}
        </p>
        {changedZone && (
          <div className="notice settings-warning">
            <h2>Подтвердите смену зоны</h2>
            <p>
              Было: <strong>{saved.timezone}</strong>
              <br />
              Станет: <strong>{timezone || "—"}</strong>
            </p>
            <p>
              UTC-моменты существующих визитов не изменятся. В новой зоне те же визиты могут
              отображаться в другой день или час. Это не автоматический перенос записей.
            </p>
            <p>
              Снимки услуг, история, статусы и защищённые ссылки сохранятся. Недельные часы и даты
              исключений не пересчитываются: новые расчёты трактуют их в новой зоне. Проверьте
              графики и исключения после смены.
            </p>
            <p>
              Несуществующее или неоднозначное время при переходах DST не сдвигается и не
              исправляется автоматически.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Подтверждаю смену зоны и понимаю последствия
            </label>
          </div>
        )}
        <button className="primary" type="submit" disabled={blocked || (changedZone && !confirmed)}>
          Сохранить настройки
        </button>
      </fieldset>
      <div ref={status} tabIndex={-1} className="catalog-status">
        {pending && !message && !failure && <p role="status">Сохраняем настройки…</p>}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {failure && (
          <div className="notice" role="alert">
            <p>{messages[failure.code]}</p>
            {failure.fields?.form && <p>{failure.fields.form}</p>}
          </div>
        )}
        {blocked && (
          <p>
            <a href="/admin/settings" target="_blank" rel="noopener noreferrer">
              Проверить актуальные настройки (новая вкладка)
            </a>
            {failure?.code === "UNAUTHORIZED" && (
              <>
                {" "}
                ·{" "}
                <a href="/admin/login" target="_blank" rel="noopener noreferrer">
                  Войти заново
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <p className="hint">
        Автосохранения нет. При переходе на другую страницу несохранённый ввод теряется.
      </p>
    </form>
  );
}
