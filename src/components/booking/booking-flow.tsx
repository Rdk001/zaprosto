"use client";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { PublicCatalog } from "../../server/public/catalog";
import type { AppointmentConfirmation } from "../../modules/appointments/server/confirmation";
import { normalizeRussianPhone } from "../../modules/booking/domain/phone";
import {
  ATTEMPT_STORAGE_KEY,
  readAttempt,
  writeAttempt,
  type SavedAttempt,
  type BookingPayload,
} from "../../modules/booking/client/attempt-storage";
import { prepareAttemptAction, createBookingAction } from "../../app/actions";
import { calendarDate, dateTime, money, time } from "./format";
import { Confirmation } from "./confirmation";

const steps = ["Услуга", "Мастер", "Дата и время", "Контакты"];
type Slots = { key: string; values: string[]; error?: string };
export function BookingFlow({ catalog }: { catalog: PublicCatalog }) {
  // Freeze the displayed catalog until an explicit server rejection requires reconfirmation.
  const [services, setServices] = useState(catalog.services);
  const [timeContext, setTimeContext] = useState(catalog.context);
  const [changedTime, setChangedTime] = useState(false);
  const generation = useRef(0);
  const [changedServiceId, setChangedServiceId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [masterId, setMasterId] = useState("");
  const [date, setDate] = useState(catalog.dates[0]);
  const [slot, setSlot] = useState("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedAttempt | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState<{
    confirmation: AppointmentConfirmation;
    token: string;
    timeZone: string;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const service = services.find((s) => s.id === serviceId);
  const masterName =
    masterId === "ANY" ? "Любой мастер" : service?.masters.find((m) => m.id === masterId)?.name;
  const selectionKey = [serviceId, masterId, date, reload, timeContext.contextHash].join("|");
  const applyTimeContext = useCallback(
    (context: PublicCatalog["context"], preferredDate?: string) => {
      ++generation.current;
      setTimeContext(context);
      setDate((current) =>
        context.dates.includes(preferredDate ?? current)
          ? (preferredDate ?? current)
          : context.dates[0],
      );
      setChangedTime(true);
      setSlot("");
      setSlots(null);
      setReview(false);
      setStep(2);
      setReload((v) => v + 1);
      setMessage(
        "Настройки времени изменились. Проверьте часовой пояс и дату, заново выберите время и подтвердите обновлённые условия. Контакты сохранены.",
      );
    },
    [],
  );

  useEffect(() => {
    function restore() {
      if (lock.current) return;
      try {
        setSaved(readAttempt(sessionStorage));
      } catch {
        setSaved({ state: "damaged" });
        setMessage(
          "Хранилище браузера недоступно. Для безопасной записи разрешите сохранение данных вкладки.",
        );
      }
      setReady(true);
    }
    restore();
    const timer = window.setInterval(restore, 15_000);
    window.addEventListener("pageshow", restore);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [step, review]);
  useEffect(() => {
    if (!serviceId || !masterId || !date) return;
    const request = ++generation.current;
    const controller = new AbortController();
    let current = true;
    const query = new URLSearchParams({
      serviceId,
      localDate: date,
      expectedBusinessContext: timeContext.contextHash,
    });
    if (masterId !== "ANY") query.set("masterId", masterId);
    fetch("/api/availability?" + query, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!current || request !== generation.current || lock.current) return;
        if (result.context && result.context.version < timeContext.version) return;
        if (
          result.context &&
          (result.context.contextHash !== timeContext.contextHash ||
            !result.context.dates.includes(date))
        ) {
          applyTimeContext(result.context);
          return;
        }
        setSlots({
          key: selectionKey,
          values: result.ok ? result.slots.map((s: { startsAt: string }) => s.startsAt) : [],
          error: result.ok
            ? undefined
            : result.code === "RATE_LIMITED"
              ? "Слишком много запросов. Подождите минуту и обновите окна."
              : "Не удалось получить окна. Обновите время или измените выбор.",
        });
      })
      .catch(() => {
        if (current && request === generation.current && !lock.current)
          setSlots({
            key: selectionKey,
            values: [],
            error: "Нет связи с сервером. Попробуйте обновить окна.",
          });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [
    serviceId,
    masterId,
    date,
    selectionKey,
    timeContext.contextHash,
    timeContext.version,
    applyTimeContext,
  ]);
  const currentSlots = slots?.key === selectionKey ? slots : null;

  function contactsValid() {
    const next: typeof errors = {};
    if (!name.trim() || name.trim().length > 200) next.name = "Укажите имя, не более 200 символов.";
    try {
      normalizeRussianPhone(phone);
    } catch {
      next.phone = "Укажите российский номер с +7 или 8 и 11 цифрами.";
    }
    setErrors(next);
    return !Object.keys(next).length;
  }
  function submit(existing?: BookingPayload) {
    if (lock.current) return;
    if (!existing && (!contactsValid() || !service || !slot)) return;
    lock.current = true;
    ++generation.current;
    setBusy(true);
    setMessage("");
    startTransition(async () => {
      try {
        let input = existing;
        if (!input) {
          const prepared = await prepareAttemptAction();
          if (!prepared.ok) {
            setMessage("Не удалось подготовить запись. Подождите минуту и попробуйте ещё раз.");
            return;
          }
          input = {
            ...prepared.attempt,
            serviceId,
            expectedServiceTerms: service!.termsHash,
            expectedBusinessContext: timeContext.contextHash,
            master: masterId === "ANY" ? { type: "ANY" } : { type: "SPECIFIC", masterId },
            localDate: date,
            startsAt: slot,
            clientName: name.trim(),
            clientPhone: phone,
          };
          const pending = { state: "pending" as const, savedAt: Date.now(), input };
          // Persistence is verified BEFORE the first mutating request.
          try {
            writeAttempt(sessionStorage, pending);
          } catch {
            setMessage(
              "Не удалось сохранить попытку в браузере. Запрос на создание не отправлен. Разрешите хранилище вкладки и повторите.",
            );
            return;
          }
          setSaved(pending);
        }
        const result = await createBookingAction(input);
        if (result.ok) {
          const receipt = { state: "receipt" as const, token: result.cancellationToken };
          writeAttempt(sessionStorage, receipt);
          setSaved(receipt);
          setSuccess({
            confirmation: result.confirmation,
            token: result.cancellationToken,
            timeZone: result.timeZone,
          });
          return;
        }
        if (
          ["UNAVAILABLE", "RATE_LIMITED", "FORBIDDEN", "IDEMPOTENCY_CONFLICT"].includes(result.code)
        ) {
          setMessage(
            result.code === "RATE_LIMITED"
              ? "Слишком много запросов. Подождите минуту и повторите ту же попытку."
              : "Результат пока не подтверждён. Повторите исходный запрос или проверьте защищённую ссылку. Новую запись пока не создавайте.",
          );
          return;
        }
        if (result.code === "SERVICE_TERMS_CHANGED") {
          setServices((current) =>
            current.map((row) =>
              row.id === result.service.id ? { ...row, ...result.service } : row,
            ),
          );
          setChangedServiceId(result.service.id);
        }
        // Confirmed domain rejection: safe to discard the pair; keep contacts.
        sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
        setSaved(null);
        setName(input.clientName);
        setPhone(input.clientPhone);
        setServiceId(input.serviceId);
        setMasterId(input.master.type === "ANY" ? "ANY" : input.master.masterId);
        setDate(input.localDate);
        setSlot("");
        setReview(false);
        setStep(2);
        setReload((v) => v + 1);
        if (result.code === "BUSINESS_CONTEXT_CHANGED")
          applyTimeContext(result.context, input.localDate);
        else
          setMessage(
            result.code === "SERVICE_TERMS_CHANGED"
              ? "Условия услуги изменились. Запись не создана. Проверьте новое название, цену и длительность, выберите доступное время и подтвердите обновлённые условия."
              : result.code === "SLOT_UNAVAILABLE"
                ? "Это время уже занято. Выберите другое окно — контакты сохранены."
                : "Запись не создана. Проверьте услугу, мастера и дату, затем выберите доступное время.",
          );
      } catch {
        setMessage(
          "Ответ не получен. Запись могла сохраниться. Повторите ту же попытку — второй записи не будет.",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    });
  }
  function clearSaved() {
    try {
      sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
      setSaved(null);
      setSuccess(null);
      setChangedServiceId(null);
      setChangedTime(false);
      setStep(0);
      setReview(false);
      setSlot("");
      setName("");
      setPhone("");
      setMessage("");
    } catch {
      setMessage("Не удалось очистить данные вкладки.");
    }
  }
  if (!ready)
    return (
      <div className="panel" role="status">
        Проверяем незавершённую запись…
      </div>
    );
  if (success)
    return (
      <div className="result-layout">
        <div className="result-intro">
          <span className="success-mark" aria-hidden="true">
            ✓
          </span>
          <p className="eyebrow">Всё готово</p>
          <h1>
            {success.confirmation.status === "SCHEDULED" ? "Вы записаны." : "Запись найдена."}
          </h1>
          <p>Детали визита — рядом. Сохраните ссылку, чтобы они всегда были под рукой.</p>
          <button className="secondary" onClick={clearSaved}>
            Создать другую запись
          </button>
        </div>
        <Confirmation
          confirmation={success.confirmation}
          token={success.token}
          timeZone={success.timeZone}
        />
      </div>
    );
  if (saved)
    return (
      <section className="panel recovery">
        <p className="eyebrow">Безопасное продолжение</p>
        <h1>
          {saved.state === "receipt" ? "Ваша запись сохранена" : "Проверим предыдущую попытку"}
        </h1>
        <p>
          {saved.state === "pending"
            ? "Мы сохранили исходные данные до отправки. Ответ мог потеряться. Повтор отправит те же данные и не создаст вторую запись."
            : saved.state === "receipt"
              ? "Откройте защищённую ссылку, чтобы увидеть актуальные детали визита."
              : "Контакты для повтора больше не хранятся. Перед новой записью проверьте предыдущую по защищённой ссылке. Если ссылка утрачена, уточните результат у барбершопа."}
        </p>
        {saved.state === "pending" && (
          <>
            <p>
              {saved.input.clientName} · {saved.input.clientPhone}
            </p>
            <button className="primary" disabled={busy} onClick={() => submit(saved.input)}>
              {busy ? "Проверяем запись…" : "Повторить исходный запрос"}
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
            Проверить по защищённой ссылке
          </a>
        )}
        {saved.state === "receipt" && (
          <button className="text-button" onClick={clearSaved}>
            Создать другую запись
          </button>
        )}
        {(saved.state === "expired" || saved.state === "damaged") && (
          <details>
            <summary>Результат уже проверен?</summary>
            <p>
              Новая попытка использует другой ключ и может создать вторую запись. Продолжайте только
              если убедились, что прежняя запись не создана или отменена.
            </p>
            <button className="secondary" onClick={clearSaved}>
              Я проверил результат — начать заново
            </button>
          </details>
        )}
        <p role="status">{message}</p>
      </section>
    );

  return (
    <div className="booking-layout">
      <div className="booking-main">
        <div className="intro">
          <p className="eyebrow">Онлайн-запись · {catalog.businessName}</p>
          <h1>
            Хорошая стрижка.
            <br />
            <span>В удобное время.</span>
          </h1>
          <p>Выберите услугу и время — остальное запросто.</p>
        </div>
        <nav aria-label="Этапы записи" className="steps">
          {steps.map((label, i) => (
            <button
              key={label}
              disabled={i > step || busy}
              aria-current={i === step ? "step" : undefined}
              onClick={() => {
                setStep(i);
                setReview(false);
              }}
            >
              <span>{i < step ? "✓" : String(i + 1).padStart(2, "0")}</span>
              <b>{label}</b>
            </button>
          ))}
        </nav>
        <section className="panel" aria-busy={busy}>
          <div className="section-title">
            <h2 ref={heading} tabIndex={-1}>
              {review
                ? "Всё верно?"
                : [
                    "Выберите услугу",
                    "К кому запишемся?",
                    "Когда вам удобно?",
                    "Как с вами связаться?",
                  ][step]}
            </h2>
            <span>{review ? "Проверка" : `0${step + 1} / 04`}</span>
          </div>
          {message && (
            <p className="notice" role="alert">
              {message}
            </p>
          )}
          {changedServiceId === serviceId && service && !review && (
            <p className="notice" aria-label="Обновлённые условия услуги">
              <strong>{service.name}</strong>
              <br />
              {money(service.priceKopecks)} · {service.durationMinutes} мин
            </p>
          )}
          {step === 0 && (
            <>
              {!services.length ? (
                <p className="empty">Пока нет доступных услуг. Попробуйте зайти позже.</p>
              ) : (
                <div className="choices">
                  {services.map((s) => (
                    <button
                      type="button"
                      className={"choice service-choice " + (serviceId === s.id ? "selected" : "")}
                      aria-pressed={serviceId === s.id}
                      key={s.id}
                      onClick={() => {
                        setServiceId(s.id);
                        setMasterId("");
                        setSlot("");
                        setReview(false);
                      }}
                    >
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.durationMinutes} мин</small>
                      </span>
                      <span className="choice-price">
                        {money(s.priceKopecks)}
                        <i aria-hidden="true">{serviceId === s.id ? "✓" : "＋"}</i>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="form-footer">
                <span>Цена и длительность одинаковы у всех мастеров</span>
                <button className="primary" disabled={!service} onClick={() => setStep(1)}>
                  Выбрать мастера →
                </button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              {!service?.masters.length ? (
                <p className="empty">
                  Для этой услуги пока нет доступных мастеров. Выберите другую услугу.
                </p>
              ) : (
                <div className="choices">
                  {[
                    {
                      id: "ANY",
                      name: "Любой мастер",
                      description: "Покажем свободное время всех подходящих мастеров",
                    },
                    ...service.masters,
                  ].map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={"choice " + (masterId === m.id ? "selected" : "")}
                      aria-pressed={masterId === m.id}
                      onClick={() => {
                        setMasterId(m.id);
                        setSlot("");
                      }}
                    >
                      <span className="avatar" aria-hidden="true">
                        {m.id === "ANY" ? "↗" : m.name.charAt(0)}
                      </span>
                      <span className="master-copy">
                        <strong>{m.name}</strong>
                        {m.description && <small>{m.description}</small>}
                      </span>
                      <i aria-hidden="true">{masterId === m.id ? "✓" : "＋"}</i>
                    </button>
                  ))}
                </div>
              )}
              <div className="form-footer">
                <button className="text-button" onClick={() => setStep(0)}>
                  ← К услугам
                </button>
                <button
                  className="primary"
                  disabled={!masterId || !service?.masters.length}
                  onClick={() => setStep(2)}
                >
                  Выбрать время →
                </button>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className="hint">
                Все даты и время — {timeContext.timeZone}, независимо от настроек вашего устройства.
              </p>
              <label className="field date-field">
                Дата визита
                <select
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setSlot("");
                  }}
                  aria-label="Дата визита"
                >
                  {timeContext.dates.map((d) => (
                    <option key={d} value={d}>
                      {calendarDate(d)}
                      {d === timeContext.dates[0] ? " · сегодня" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="slots-heading">
                <h3>Свободное время</h3>
                <button
                  className="text-button"
                  onClick={() => {
                    setSlot("");
                    setReload((v) => v + 1);
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
              ) : !currentSlots.values.length ? (
                <p className="empty">
                  На эту дату свободных окон нет. Выберите другой день или мастера.
                </p>
              ) : (
                <div className="slots" aria-label="Доступное время">
                  {currentSlots.values.map((s) => (
                    <button
                      type="button"
                      key={s}
                      aria-pressed={slot === s}
                      className={slot === s ? "selected" : ""}
                      onClick={() => setSlot(s)}
                    >
                      {time(s, timeContext.timeZone)}
                    </button>
                  ))}
                </div>
              )}
              <div className="form-footer">
                <button className="text-button" onClick={() => setStep(1)}>
                  ← К мастерам
                </button>
                <button
                  className="primary"
                  disabled={!slot || !currentSlots?.values.includes(slot)}
                  onClick={() => setStep(3)}
                >
                  Продолжить →
                </button>
              </div>
            </>
          )}
          {step === 3 && !review && (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (contactsValid()) setReview(true);
              }}
            >
              <p className="hint">Только имя и телефон. Регистрация не нужна.</p>
              <label className="field">
                Ваше имя
                <input
                  autoComplete="given-name"
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? "name-error" : undefined}
                />
              </label>
              {errors.name && (
                <p id="name-error" className="field-error" role="alert">
                  {errors.name}
                </p>
              )}
              <label className="field">
                Номер телефона
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+7 (___) ___-__-__"
                  maxLength={64}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  aria-invalid={!!errors.phone}
                  aria-describedby="phone-hint phone-error"
                />
              </label>
              <p id="phone-hint" className="hint">
                Можно начать с +7 или 8. Пробелы, скобки и дефисы допустимы.
              </p>
              <p id="phone-error" className="field-error" role="alert">
                {errors.phone}
              </p>
              <div className="form-footer">
                <button type="button" className="text-button" onClick={() => setStep(2)}>
                  ← К времени
                </button>
                <button className="primary" type="submit">
                  Проверить запись →
                </button>
              </div>
            </form>
          )}
          {review && (
            <>
              <dl className="details review-details">
                <div>
                  <dt>Услуга</dt>
                  <dd>{service?.name}</dd>
                </div>
                <div>
                  <dt>Мастер</dt>
                  <dd>{masterName}</dd>
                </div>
                <div>
                  <dt>Дата и время</dt>
                  <dd>{dateTime(slot, timeContext.timeZone)}</dd>
                </div>
                <div>
                  <dt>Длительность</dt>
                  <dd>{service?.durationMinutes} мин</dd>
                </div>
                <div>
                  <dt>Стоимость</dt>
                  <dd>{money(service?.priceKopecks ?? 0)}</dd>
                </div>
                <div>
                  <dt>Имя</dt>
                  <dd>{name.trim()}</dd>
                </div>
                <div>
                  <dt>Телефон</dt>
                  <dd>{phone}</dd>
                </div>
              </dl>
              <p className="hint">
                После подтверждения появится защищённая ссылка для просмотра и отмены. Контакты для
                безопасного повтора хранятся в этой вкладке до 30 минут.
              </p>
              <div className="form-footer">
                <button className="text-button" disabled={busy} onClick={() => setReview(false)}>
                  Изменить контакты
                </button>
                <button className="primary" disabled={busy} onClick={() => submit()}>
                  {busy
                    ? "Создаём запись…"
                    : changedServiceId === serviceId || changedTime
                      ? "Подтвердить обновлённые условия"
                      : "Подтвердить запись"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      <aside className="booking-aside">
        <div className="summary-card">
          <span className="eyebrow">Ваш визит</span>
          <div className="summary-symbol" aria-hidden="true">
            з.
          </div>
          <h2>{service?.name ?? "Всё начинается с выбора"}</h2>
          <p>
            {service
              ? `${service.durationMinutes} мин · ${money(service.priceKopecks)}`
              : "Услуга, мастер и время — здесь будут детали вашей записи."}
          </p>
          <div className="summary-lines">
            <p>
              <span>Мастер</span>
              <strong>{masterName ?? "Ещё не выбран"}</strong>
            </p>
            <p>
              <span>Когда</span>
              <strong>{slot ? dateTime(slot, timeContext.timeZone) : "Выберите время"}</strong>
            </p>
          </div>
          <p className="summary-note">
            Планы изменились?
            <br />
            Запись можно отменить по защищённой ссылке.
          </p>
        </div>
        <p className="aside-caption">ЗАПРОСТО / ЗАПИСЬ БЕЗ ЛИШНИХ ШАГОВ</p>
      </aside>
    </div>
  );
}
