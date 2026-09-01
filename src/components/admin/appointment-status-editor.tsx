"use client";
import { useRef, useState, useTransition } from "react";
import { changeAppointmentStatusAction } from "../../app/admin/appointment-actions";
import {
  allowedTransition,
  statusLabels,
  MAX_REASON,
  type Status,
  type AppointmentFailure,
} from "../../modules/appointments/domain/admin-input";

const messages: Record<AppointmentFailure["code"], string> = {
  INVALID_INPUT: "Проверьте поля. Причина отмены — не более 1000 символов.",
  UNAUTHORIZED: "Сеанс завершён или доступ отключён. Войдите в новой вкладке и сверьте карточку.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по основному адресу.",
  UNAVAILABLE:
    "Сохранение не подтверждено. Результат неизвестен. Причина сохранена здесь. Не повторяйте запрос: сверьте карточку в новой вкладке.",
  NOT_FOUND: "Запись не найдена. Сверьте журнал в новой вкладке.",
  CONFLICT:
    "Запись или настройки времени уже изменились. Причина сохранена здесь. Сверьте карточку в новой вкладке; затем используйте свежую форму.",
  INVALID_TRANSITION: "Этот переход статуса запрещён. Сверьте карточку в новой вкладке.",
  NOT_STARTED: "Визит ещё не начался по серверному времени. Результат можно отметить после начала.",
  CONFIRMATION_REQUIRED: "Для отмены нужно явное подтверждение.",
  INVALID_DAY: "Не удалось определить границы локального дня.",
};
export function AppointmentStatusEditor({
  id,
  version,
  status: initialStatus,
  businessContext,
  href,
}: {
  id: string;
  version: number;
  status: Status;
  businessContext: string;
  href: string;
}) {
  const [target, setTarget] = useState<Status | "">("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<AppointmentFailure | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false),
    feedback = useRef<HTMLDivElement>(null);
  const blocked =
    !!failure && !["INVALID_INPUT", "NOT_STARTED", "CONFIRMATION_REQUIRED"].includes(failure.code);
  const choices = (Object.keys(statusLabels) as Status[]).filter((next) =>
    allowedTransition(initialStatus, next),
  );
  return (
    <section className="panel admin-form" aria-labelledby="status-title">
      <h2 id="status-title">Статус записи</h2>
      <p className="appointment-status-label">
        <strong>{statusLabels[initialStatus]}</strong>
      </p>
      {choices.length ? (
        <form
          noValidate
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy.current || blocked || !target) return;
            busy.current = true;
            setFailure(null);
            startTransition(async () => {
              try {
                const result = await changeAppointmentStatusAction({
                  id,
                  version,
                  expectedBusinessContext: businessContext,
                  status: target,
                  confirmed,
                  ...(target === "CANCELLED" ? { reason } : {}),
                });
                if (result.ok) {
                  // Full document navigation reloads status/history together with a fresh CSP nonce.
                  window.location.assign(href);
                  return;
                }
                setFailure(result);
              } catch {
                setFailure({ ok: false, code: "UNAVAILABLE" });
              }
              busy.current = false;
              requestAnimationFrame(() => feedback.current?.focus());
            });
          }}
        >
          <fieldset className="catalog-fields" disabled={pending}>
            <legend className="sr-only">Изменение статуса</legend>
            <label className="field">
              Новый статус
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value as Status | "");
                  setConfirmed(false);
                }}
              >
                <option value="">Выберите статус</option>
                {choices.map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              «Выполнена» и «Клиент не пришёл» доступны только после начала визита. Сервер проверит
              время при сохранении.
            </p>
            {target === "CANCELLED" && (
              <div className="notice appointment-cancel">
                <p>Отмена окончательная: восстановить запись нельзя. Слот освободится.</p>
                <p>
                  <strong>Автоматические уведомления ещё не реализованы.</strong> При отмене
                  самостоятельно свяжитесь с клиентом.
                </p>
                <label className="field">
                  Причина отмены (необязательно)
                  <textarea
                    value={reason}
                    maxLength={MAX_REASON}
                    rows={3}
                    onChange={(e) => setReason(e.target.value)}
                    aria-describedby="reason-hint"
                  />
                </label>
                <p className="hint" id="reason-hint">
                  До {MAX_REASON} символов. Причина сохранится в истории.
                </p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Подтверждаю отмену записи
                </label>
              </div>
            )}
            <button
              className="primary"
              type="submit"
              disabled={blocked || !target || (target === "CANCELLED" && !confirmed)}
            >
              Сохранить статус
            </button>
          </fieldset>
        </form>
      ) : (
        <p>Отмена окончательная. Восстановление записи недоступно.</p>
      )}
      <div ref={feedback} tabIndex={-1} className="catalog-status">
        {pending && <p role="status">Сохраняем статус…</p>}
        {failure && (
          <p className="notice" role="alert">
            {messages[failure.code]}
          </p>
        )}
        {blocked && (
          <p>
            <a href={href} target="_blank" rel="noopener noreferrer">
              Сверить карточку (новая вкладка)
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
      {!!choices.length && (
        <p className="hint">
          Автосохранения нет. При уходе со страницы введённая причина теряется.
        </p>
      )}
    </section>
  );
}
