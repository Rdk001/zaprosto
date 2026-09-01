"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  createAdminAppointmentAction,
  getAdminAppointmentAvailabilityAction,
  prepareAdminAppointmentAction,
} from "../../app/admin/appointment-actions";
import { buildAdminConfirmationText } from "../../modules/appointments/domain/admin-confirmation";
import type { AppointmentConfirmation } from "../../modules/appointments/server/confirmation";
import {
  ADMIN_ATTEMPT_STORAGE_KEY,
  readAdminAttempt,
  writeAdminAttempt,
  type AdminBookingPayload,
  type SavedAdminAttempt,
} from "../../modules/booking/client/admin-attempt-storage";
import { normalizeRussianPhone } from "../../modules/booking/domain/phone";
import type { BookingCatalog } from "../../modules/booking/server/booking-catalog";
import { calendarDate, dateTime, money, time } from "../booking/format";

type Slots = { key: string; values: string[]; error?: string };
const steps = ["Услуга и мастер", "Дата и время", "Клиент", "Проверка"];

export function AppointmentCreateFlow({ catalog: initialCatalog }: { catalog: BookingCatalog }) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [masterId, setMasterId] = useState("");
  const [localDate, setLocalDate] = useState(initialCatalog.dates[0]);
  const [startsAt, setStartsAt] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [reload, setReload] = useState(0);
  const [errors, setErrors] = useState<{ clientName?: string; clientPhone?: string }>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedAdminAttempt | null>(null);
  const [success, setSuccess] = useState<{
    confirmation: AppointmentConfirmation;
    token: string;
    timeZone: string;
  } | null>(null);
  const [copyError, setCopyError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  const service = catalog.services.find((row) => row.id === serviceId);
  const selectionKey = [serviceId, masterId, localDate, reload, catalog.context.contextHash].join(
    "|",
  );

  const applyContext = useCallback((context: BookingCatalog["context"]) => {
    setCatalog((current) => ({
      ...current,
      timeZone: context.timeZone,
      dates: context.dates,
      context,
    }));
    setLocalDate((current) => (context.dates.includes(current) ? current : context.dates[0]));
    setStartsAt("");
    setConfirmed(false);
    setSlots(null);
    setStep(1);
    setMessage(
      "Настройки времени изменились. Заново выберите дату и время, затем ещё раз проверьте итоговые данные.",
    );
    setReload((value) => value + 1);
  }, []);

  useEffect(() => {
    const restore = () => {
      if (lock.current) return;
      try {
        setSaved(readAdminAttempt(sessionStorage));
      } catch {
        setSaved({ state: "damaged" });
        setMessage(
          "Хранилище вкладки недоступно. Создание не будет отправлено без безопасной попытки.",
        );
      }
      setReady(true);
    };
    restore();
    window.addEventListener("pageshow", restore);
    const timer = window.setInterval(restore, 15_000);
    return () => {
      window.removeEventListener("pageshow", restore);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!serviceId || !masterId || !localDate || saved || success) return;
    const request = ++generation.current;
    startTransition(async () => {
      try {
        const result = await getAdminAppointmentAvailabilityAction({
          serviceId,
          localDate,
          ...(masterId === "ANY" ? {} : { masterId }),
          expectedBusinessContext: catalog.context.contextHash,
        });
        if (request !== generation.current || lock.current) return;
        if (result.ok) {
          setSlots({ key: selectionKey, values: result.slots.map((slot) => slot.startsAt) });
          return;
        }
        if (result.code === "BUSINESS_CONTEXT_CHANGED") {
          applyContext(result.context);
          return;
        }
        setSlots({
          key: selectionKey,
          values: [],
          error:
            result.code === "UNAUTHORIZED"
              ? "Сеанс завершён. Войдите снова и обновите страницу."
              : result.code === "SELECTION_UNAVAILABLE"
                ? "Услуга или мастер больше недоступны. Обновите страницу."
                : "Не удалось получить свободное время. Повторите запрос.",
        });
      } catch {
        if (request === generation.current)
          setSlots({
            key: selectionKey,
            values: [],
            error: "Нет связи с сервером. Повторите запрос свободного времени.",
          });
      }
    });
  }, [
    serviceId,
    masterId,
    localDate,
    reload,
    selectionKey,
    catalog.context.contextHash,
    applyContext,
    saved,
    success,
  ]);

  useEffect(() => {
    if (message) requestAnimationFrame(() => feedback.current?.focus());
  }, [message]);

  const currentSlots = slots?.key === selectionKey ? slots : null;

  function validateContacts() {
    const next: typeof errors = {};
    if (!clientName.trim() || clientName.trim().length > 200)
      next.clientName = "Укажите имя, не более 200 символов.";
    try {
      normalizeRussianPhone(clientPhone);
    } catch {
      next.clientPhone = "Укажите российский номер с +7 или 8 и 11 цифрами.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function clearAttempt() {
    sessionStorage.removeItem(ADMIN_ATTEMPT_STORAGE_KEY);
    setSaved(null);
  }

  function resetForConfirmedFailure(input: AdminBookingPayload) {
    clearAttempt();
    setClientName(input.clientName);
    setClientPhone(input.clientPhone);
    setServiceId(input.serviceId);
    setMasterId(input.master.type === "ANY" ? "ANY" : input.master.masterId);
    setLocalDate(input.localDate);
    setStartsAt("");
    setStep(1);
    setReload((value) => value + 1);
  }

  function submit(existing?: AdminBookingPayload) {
    if (lock.current) return;
    if (!existing && (!confirmed || !service || !startsAt || !validateContacts())) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    ++generation.current;
    startTransition(async () => {
      try {
        let input = existing;
        if (!input) {
          const prepared = await prepareAdminAppointmentAction();
          if (!prepared.ok) {
            setMessage(
              prepared.code === "UNAUTHORIZED"
                ? "Сеанс завершён. Войдите снова; данные формы сохранены в этой вкладке."
                : "Не удалось подготовить безопасную попытку. Создание не отправлено.",
            );
            return;
          }
          input = {
            ...prepared.attempt,
            serviceId,
            expectedServiceTerms: service!.termsHash,
            expectedBusinessContext: catalog.context.contextHash,
            master: masterId === "ANY" ? { type: "ANY" } : { type: "SPECIFIC", masterId },
            localDate,
            startsAt,
            clientName: clientName.trim(),
            clientPhone,
            confirmed: true,
          };
          const pending = { state: "pending" as const, savedAt: Date.now(), input };
          try {
            writeAdminAttempt(sessionStorage, pending);
          } catch {
            setMessage(
              "Не удалось сохранить исходную попытку в sessionStorage. Запрос на создание не отправлен.",
            );
            return;
          }
          setSaved(pending);
        }

        const result = await createAdminAppointmentAction(input);
        if (result.ok) {
          const receipt = { state: "receipt" as const, token: result.cancellationToken };
          writeAdminAttempt(sessionStorage, receipt);
          setSaved(receipt);
          setSuccess({
            confirmation: result.confirmation,
            token: result.cancellationToken,
            timeZone: result.timeZone,
          });
          return;
        }
        if (
          ["UNAVAILABLE", "FORBIDDEN", "UNAUTHORIZED", "IDEMPOTENCY_CONFLICT"].includes(result.code)
        ) {
          setMessage(
            result.code === "UNAUTHORIZED"
              ? "Доступ потерян. Исходная попытка сохранена. После входа повторите только её."
              : "Результат не подтверждён. Не создавайте новую запись: повторите только исходный запрос после безопасной сверки.",
          );
          return;
        }

        resetForConfirmedFailure(input);
        if (result.code === "BUSINESS_CONTEXT_CHANGED") {
          applyContext(result.context);
        } else if (result.code === "SERVICE_TERMS_CHANGED") {
          setCatalog((current) => ({
            ...current,
            services: current.services.map((row) =>
              row.id === result.service.id ? { ...row, ...result.service } : row,
            ),
          }));
          setMessage(
            "Условия услуги изменились. Запись не создана. Проверьте цену и длительность, выберите новое время и подтвердите снова.",
          );
        } else if (result.code === "SLOT_UNAVAILABLE") {
          setMessage("Выбранное время уже недоступно. Выберите другое; контакты сохранены.");
        } else if (result.code === "INVALID_INPUT") {
          setStep(2);
          setMessage("Проверьте имя, телефон и остальные поля. Запись не создана.");
        } else {
          setStep(0);
          setMessage("Услуга или мастер больше недоступны. Обновите выбор.");
        }
      } catch {
        setMessage(
          "Ответ потерян: запись могла сохраниться. Новую запись не создавайте. Повторите только исходную попытку.",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    });
  }

  async function copy(value: string, field: HTMLInputElement | HTMLTextAreaElement | null) {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Скопировано в буфер обмена.");
    } catch {
      setCopyError("Автоматическое копирование не сработало. Поле выделено — скопируйте вручную.");
      requestAnimationFrame(() => {
        field?.focus();
        field?.select();
      });
    }
  }

  function startAnother() {
    clearAttempt();
    setSuccess(null);
    setServiceId("");
    setMasterId("");
    setStartsAt("");
    setClientName("");
    setClientPhone("");
    setConfirmed(false);
    setStep(0);
    setMessage("");
    setCopyError("");
  }

  if (!ready)
    return (
      <p className="panel" role="status">
        Проверяем незавершённую ручную запись…
      </p>
    );

  if (success) {
    const protectedUrl = window.location.origin + "/appointment#" + success.token;
    const confirmationText = buildAdminConfirmationText({
      confirmation: success.confirmation,
      timeZone: success.timeZone,
      protectedUrl,
    });
    return (
      <section className="admin-create-success" aria-labelledby="admin-create-success-title">
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / ЗАПИСЬ СОЗДАНА</p>
          <h1 id="admin-create-success-title">Запись готова</h1>
          <p>Передайте клиенту текст и защищённую ссылку вручную.</p>
        </div>
        <div className="panel">
          <dl className="appointment-facts">
            <div>
              <dt>Услуга</dt>
              <dd>
                {success.confirmation.service.name} ·{" "}
                {money(success.confirmation.service.priceKopecks)}
              </dd>
            </div>
            <div>
              <dt>Мастер</dt>
              <dd>{success.confirmation.master.name}</dd>
            </div>
            <div>
              <dt>Дата и время</dt>
              <dd>{dateTime(success.confirmation.startsAt, success.timeZone)}</dd>
            </div>
            <div>
              <dt>Клиент</dt>
              <dd>{success.confirmation.clientName}</dd>
            </div>
          </dl>
          <label className="field">
            Текст подтверждения
            <textarea ref={textField} readOnly rows={8} value={confirmationText} />
          </label>
          <button
            className="secondary"
            type="button"
            onClick={() => copy(confirmationText, textField.current)}
          >
            Копировать текст
          </button>
          <label className="field">
            Защищённая клиентская ссылка
            <input ref={linkField} readOnly value={protectedUrl} />
          </label>
          <p className="hint">
            Ссылка позволяет просмотреть и отменить запись. Не передавайте её посторонним.
          </p>
          <button
            className="secondary"
            type="button"
            onClick={() => copy(protectedUrl, linkField.current)}
          >
            Копировать ссылку
          </button>
          {copyError && (
            <p className="notice" role="alert">
              {copyError}
            </p>
          )}
          <div className="form-footer">
            <a className="primary" href={"/admin/appointments/" + success.confirmation.id}>
              Открыть карточку записи
            </a>
            <button className="text-button" type="button" onClick={startAnother}>
              Создать ещё запись
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (saved)
    return (
      <section className="panel recovery">
        <p className="eyebrow">БЕЗОПАСНАЯ СВЕРКА</p>
        <h1>{saved.state === "receipt" ? "Запись уже создана" : "Есть незавершённая попытка"}</h1>
        <p>
          {saved.state === "pending"
            ? "Ответ мог потеряться. Повтор отправит тот же payload с тем же ключом и токеном."
            : saved.state === "receipt"
              ? "Защищённая ссылка сохранена в этой вкладке. Проверьте запись перед новой попыткой."
              : "Исходные контакты больше не хранятся. Новая попытка заблокирована до ручной сверки."}
        </p>
        {saved.state === "pending" && (
          <>
            <p>
              {saved.input.clientName} · {saved.input.clientPhone}
            </p>
            <button className="primary" disabled={busy} onClick={() => submit(saved.input)}>
              {busy ? "Сверяем…" : "Повторить исходный запрос"}
            </button>
          </>
        )}
        {saved.state !== "damaged" && (
          <a
            className="secondary"
            href={
              "/appointment#" +
              (saved.state === "pending" ? saved.input.cancellationToken : saved.token)
            }
          >
            Проверить клиентскую ссылку
          </a>
        )}
        {(saved.state === "expired" || saved.state === "damaged") && (
          <details>
            <summary>Результат уже проверен?</summary>
            <p>
              Продолжайте только после проверки журнала и клиентской ссылки: новая пара может
              создать дубликат.
            </p>
            <button className="secondary" type="button" onClick={startAnother}>
              Я проверил результат — начать заново
            </button>
          </details>
        )}
        {message && (
          <p ref={feedback} tabIndex={-1} className="notice" role="alert">
            {message}
          </p>
        )}
      </section>
    );

  return (
    <section className="admin-create-flow" aria-labelledby="admin-create-title">
      <div className="appointment-heading">
        <p className="eyebrow">ЗАПРОСТО / НОВАЯ ЗАПИСЬ</p>
        <h1 id="admin-create-title">Создать запись</h1>
        <p>Телефонная или офлайн-запись сразу займёт выбранный интервал.</p>
      </div>
      <nav className="steps admin-create-steps" aria-label="Этапы ручной записи">
        {steps.map((label, index) => (
          <button
            key={label}
            type="button"
            disabled={index > step || busy}
            aria-current={index === step ? "step" : undefined}
            onClick={() => setStep(index)}
          >
            <span>{index < step ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <b>{label}</b>
          </button>
        ))}
      </nav>
      <div className="panel admin-form" aria-busy={busy}>
        {message && (
          <p ref={feedback} tabIndex={-1} className="notice" role="alert">
            {message}
          </p>
        )}
        {step === 0 && (
          <>
            <label className="field">
              Активная услуга
              <select
                value={serviceId}
                onChange={(event) => {
                  setServiceId(event.target.value);
                  setMasterId("");
                  setStartsAt("");
                }}
              >
                <option value="">Выберите услугу</option>
                {catalog.services.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} — {money(row.priceKopecks)} — {row.durationMinutes} мин
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Мастер
              <select
                value={masterId}
                disabled={!service}
                onChange={(event) => {
                  setMasterId(event.target.value);
                  setStartsAt("");
                }}
              >
                <option value="">Выберите мастера</option>
                {!!service?.masters.length && <option value="ANY">Любой мастер</option>}
                {service?.masters.map((master) => (
                  <option key={master.id} value={master.id}>
                    {master.name}
                  </option>
                ))}
              </select>
            </label>
            {!catalog.services.length && <p className="empty">Нет активных услуг.</p>}
            {service && !service.masters.length && (
              <p className="empty">У этой услуги нет активных подходящих мастеров.</p>
            )}
            <div className="form-footer">
              <span>Показываются только активные назначения</span>
              <button
                className="primary"
                type="button"
                disabled={!service || !masterId}
                onClick={() => setStep(1)}
              >
                Выбрать время →
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p className="hint">Все даты и время — {catalog.context.timeZone}.</p>
            <label className="field">
              Дата визита
              <select
                value={localDate}
                onChange={(event) => {
                  setLocalDate(event.target.value);
                  setStartsAt("");
                }}
              >
                {catalog.context.dates.map((date) => (
                  <option key={date} value={date}>
                    {calendarDate(date)}
                  </option>
                ))}
              </select>
            </label>
            <div className="slots-heading">
              <h2>Свободное время</h2>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setStartsAt("");
                  setReload((value) => value + 1);
                }}
              >
                Обновить
              </button>
            </div>
            {!currentSlots ? (
              <p className="empty" role="status">
                Ищем свободное время…
              </p>
            ) : currentSlots.error ? (
              <p className="notice" role="alert">
                {currentSlots.error}
              </p>
            ) : currentSlots.values.length ? (
              <div className="slots" aria-label="Свободное время">
                {currentSlots.values.map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={startsAt === value}
                    className={startsAt === value ? "selected" : ""}
                    onClick={() => setStartsAt(value)}
                  >
                    {time(value, catalog.context.timeZone)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty">На выбранную дату свободных интервалов нет.</p>
            )}
            <div className="form-footer">
              <button className="text-button" type="button" onClick={() => setStep(0)}>
                ← К выбору
              </button>
              <button
                className="primary"
                type="button"
                disabled={!startsAt || !currentSlots?.values.includes(startsAt)}
                onClick={() => setStep(2)}
              >
                Ввести клиента →
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (validateContacts()) {
                setConfirmed(false);
                setStep(3);
              }
            }}
          >
            <label className="field">
              Имя клиента
              <input
                value={clientName}
                maxLength={200}
                autoComplete="name"
                onChange={(event) => setClientName(event.target.value)}
                aria-invalid={!!errors.clientName}
              />
            </label>
            {errors.clientName && (
              <p className="field-error" role="alert">
                {errors.clientName}
              </p>
            )}
            <label className="field">
              Российский телефон
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+7 (___) ___-__-__"
                maxLength={64}
                value={clientPhone}
                onChange={(event) => setClientPhone(event.target.value)}
                aria-invalid={!!errors.clientPhone}
                aria-describedby="admin-phone-hint"
              />
            </label>
            <p id="admin-phone-hint" className="hint">
              Префикс +7 или 8; пробелы, скобки и дефисы допустимы.
            </p>
            {errors.clientPhone && (
              <p className="field-error" role="alert">
                {errors.clientPhone}
              </p>
            )}
            <div className="form-footer">
              <button className="text-button" type="button" onClick={() => setStep(1)}>
                ← Ко времени
              </button>
              <button className="primary" type="submit">
                Проверить данные →
              </button>
            </div>
          </form>
        )}
        {step === 3 && (
          <>
            <dl className="appointment-facts">
              <div>
                <dt>Услуга</dt>
                <dd>
                  {service?.name} · {money(service?.priceKopecks ?? 0)} · {service?.durationMinutes}{" "}
                  мин
                </dd>
              </div>
              <div>
                <dt>Выбор мастера</dt>
                <dd>
                  {masterId === "ANY"
                    ? "Любой мастер"
                    : service?.masters.find((row) => row.id === masterId)?.name}
                </dd>
              </div>
              <div>
                <dt>Дата и время</dt>
                <dd>{dateTime(startsAt, catalog.context.timeZone)}</dd>
              </div>
              <div>
                <dt>Клиент</dt>
                <dd>
                  {clientName.trim()} · {clientPhone}
                </dd>
              </div>
            </dl>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Подтверждаю создание этой записи
            </label>
            <p className="hint">
              Перед первым запросом исходная пара и контакты сохранятся только в sessionStorage этой
              вкладки на 30 минут.
            </p>
            <div className="form-footer">
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => setStep(2)}
              >
                Изменить данные
              </button>
              <button
                className="primary"
                type="button"
                disabled={busy || !confirmed}
                onClick={() => submit()}
              >
                {busy ? "Создаём запись…" : "Подтвердить создание"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
