/* Full navigation intentionally reloads the nonce-protected document and session recovery state. */
/* eslint-disable @next/next/no-html-link-for-pages */
"use client";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { bookingTokenSchema } from "../../modules/booking/domain/booking-input";
import { lookupAppointmentAction, cancelBookingAction } from "../../app/actions";
import { Confirmation, statusLabels } from "./confirmation";

type Result = Awaited<ReturnType<typeof lookupAppointmentAction>>;
export function AppointmentView() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback((secret: string) => {
    const request = ++generation.current;
    startTransition(async () => {
      try {
        const next = await lookupAppointmentAction(secret);
        if (request === generation.current) setResult(next);
      } catch {
        if (request === generation.current) setResult({ ok: false, code: "UNAVAILABLE" });
      }
    });
  }, []);
  const invalidateRequests = useCallback(() => {
    generation.current += 1;
  }, []);
  useEffect(() => {
    const load = () => {
      const secret = window.location.hash.slice(1);
      setToken(secret);
      setResult(null);
      setAsking(false);
      setMessage("");
      if (!bookingTokenSchema.safeParse(secret).success) {
        ++generation.current;
        setResult({ ok: false, code: "NOT_FOUND" });
        return;
      }
      refresh(secret);
    };
    load();
    window.addEventListener("hashchange", load);
    // This ref is a request sequence, not a DOM node; invalidate all outstanding requests on cleanup.
    return () => {
      invalidateRequests();
      window.removeEventListener("hashchange", load);
    };
  }, [refresh, invalidateRequests]);
  function cancel() {
    if (lock.current || !confirmed) return;
    const request = ++generation.current;
    lock.current = true;
    setBusy(true);
    setMessage("");
    startTransition(async () => {
      try {
        const response = await cancelBookingAction({ token, confirmed: true, reason });
        if (request !== generation.current) return;
        if (response.ok && result?.ok) {
          setResult({ ...result, confirmation: response.confirmation });
          setAsking(false);
          setMessage(
            response.alreadyCancelled
              ? "Эта запись уже отменена. Повторная отмена не нужна."
              : "Запись отменена. Время снова доступно для записи.",
          );
        } else if (!response.ok) {
          setMessage(
            response.code === "STATUS_NOT_CANCELLABLE"
              ? "Статус записи изменился. Отменить её уже нельзя."
              : response.code === "INVALID_INPUT"
                ? "Подтвердите отмену и проверьте длину причины."
                : response.code === "RATE_LIMITED"
                  ? "Слишком много запросов. Подождите минуту."
                  : "Ответ не получен или ссылка недоступна. Обновите статус перед повтором.",
          );
          refresh(token);
        }
      } catch {
        if (request !== generation.current) return;
        setMessage(
          "Ответ не получен. Отмена могла сохраниться. Обновите статус или повторите отмену.",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    });
  }
  return (
    <div className="appointment-page">
      <div className="appointment-heading">
        <p className="eyebrow">По защищённой ссылке</p>
        <h1>Ваш визит.</h1>
        <p>Актуальные детали записи и управление отменой.</p>
      </div>
      {!result ? (
        <section className="panel" role="status">
          Загружаем запись…
        </section>
      ) : !result.ok ? (
        <section className="panel">
          <h2>
            {result.code === "NOT_FOUND" ? "Ссылка недействительна" : "Не удалось загрузить запись"}
          </h2>
          <p>
            {result.code === "NOT_FOUND"
              ? "Проверьте, что ссылка скопирована полностью. Данные записи доступны только по защищённой ссылке."
              : result.code === "RATE_LIMITED"
                ? "Слишком много проверок. Подождите минуту и попробуйте снова."
                : "Сервис временно недоступен. Попробуйте ещё раз — это не изменит запись."}
          </p>
          {result.code !== "NOT_FOUND" && (
            <button className="primary" onClick={() => refresh(token)}>
              Повторить проверку
            </button>
          )}
        </section>
      ) : (
        <>
          <Confirmation
            confirmation={result.confirmation}
            timeZone={result.timeZone}
            token={token}
          />
          <section className="panel cancellation">
            <div className="section-title">
              <h2>Планы изменились?</h2>
              <button className="text-button" disabled={busy} onClick={() => refresh(token)}>
                Обновить статус
              </button>
            </div>
            {result.confirmation.status === "SCHEDULED" ? (
              !asking ? (
                <>
                  <p>
                    Вы можете отменить этот визит. Для другого времени сначала отмените текущую
                    запись, затем создайте новую.
                  </p>
                  <button
                    className="secondary danger"
                    onClick={() => {
                      setAsking(true);
                      setConfirmed(false);
                    }}
                  >
                    Отменить запись
                  </button>
                </>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    cancel();
                  }}
                >
                  <h3>Подтвердите отмену</h3>
                  <p>После отмены время освободится. Восстановить эту запись нельзя.</p>
                  <label className="field">
                    Причина отмены <span className="hint">(необязательно)</span>
                    <textarea
                      maxLength={1000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      required
                    />
                    Я хочу отменить эту запись
                  </label>
                  <div className="form-footer">
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => setAsking(false)}
                    >
                      Оставить запись
                    </button>
                    <button className="primary danger" type="submit" disabled={!confirmed || busy}>
                      {busy ? "Отменяем…" : "Да, отменить запись"}
                    </button>
                  </div>
                </form>
              )
            ) : (
              <p>
                {result.confirmation.status === "CANCELLED"
                  ? "Эта запись уже отменена. Повторная отмена не требуется."
                  : `Статус «${statusLabels[result.confirmation.status]}» не допускает отмену.`}
              </p>
            )}
            <p role="status" className={message ? "notice" : ""}>
              {message}
            </p>
          </section>
        </>
      )}
      <a className="text-button" href="/">
        ← К онлайн-записи
      </a>
    </div>
  );
}
