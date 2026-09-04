"use client";

import { useMemo, useRef, useState } from "react";

import {
  getAppointmentRescheduleAvailabilityAction,
  rescheduleAppointmentAction,
} from "../../app/admin/appointment-actions";
import type { AppointmentServiceSelection } from "../../modules/appointments/domain/admin-reschedule-input";
import { calendarDate, dateTime, money, time } from "../booking/format";

type MasterChoice = { id: string; name: string };
type CatalogService = {
  id: string;
  name: string;
  priceKopecks: number;
  durationMinutes: number;
  termsHash: string;
  masters: MasterChoice[];
};
type BusinessContext = {
  contextHash: string;
  timeZone: string;
  dates: string[];
};
type Slot = { startsAt: string; endsAt: string };
type Failure = { code: FailureCode; phase: "availability" | "mutation" };
type FailureCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "EDIT_NOT_ALLOWED"
  | "SELECTION_UNAVAILABLE"
  | "SERVICE_TERMS_CHANGED"
  | "BUSINESS_CONTEXT_CHANGED"
  | "START_NOT_IN_FUTURE"
  | "NO_CHANGES"
  | "SLOT_UNAVAILABLE";
type AvailabilityState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "error"; key: string }
  | { status: "ready"; key: string; slots: Slot[]; timeZone: string };

const blockingFailures = new Set<FailureCode>([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UNAVAILABLE",
  "NOT_FOUND",
  "CONFLICT",
  "EDIT_NOT_ALLOWED",
  "SELECTION_UNAVAILABLE",
  "SERVICE_TERMS_CHANGED",
  "BUSINESS_CONTEXT_CHANGED",
]);

const messages: Record<FailureCode, string> = {
  INVALID_INPUT:
    "Не удалось проверить данные переноса. Перечитайте карточку, если повторная проверка не помогает.",
  UNAUTHORIZED:
    "Сеанс завершён или доступ отключён. Данные карточки больше не считаются актуальными.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по основному адресу.",
  UNAVAILABLE:
    "Результат сохранения неизвестен: сервер мог успеть выполнить перенос. Не повторяйте запрос — сначала сверьте карточку в новой вкладке или полностью перечитайте её.",
  NOT_FOUND:
    "Не удалось продолжить работу с карточкой. Полностью перечитайте журнал перед новой попыткой.",
  CONFLICT:
    "Запись уже изменилась. Черновик сохранён в этой вкладке, но повтор со старой версией заблокирован.",
  EDIT_NOT_ALLOWED:
    "Параметры этой записи больше нельзя изменять. Полностью перечитайте карточку, чтобы увидеть актуальный статус.",
  SELECTION_UNAVAILABLE:
    "Выбранная услуга или мастер больше недоступны. Перечитайте карточку и выберите параметры заново.",
  SERVICE_TERMS_CHANGED:
    "Условия услуги в каталоге изменились. Новые условия не приняты автоматически: перечитайте карточку и сделайте выбор заново.",
  BUSINESS_CONTEXT_CHANGED:
    "Часовой пояс или горизонт записи изменились. Перечитайте карточку и заново выберите дату и время.",
  START_NOT_IN_FUTURE:
    "Выбранное время уже наступило. Обновите свободное время и выберите другой интервал.",
  NO_CHANGES: "Параметры визита не отличаются от сохранённых. Выберите реальное изменение.",
  SLOT_UNAVAILABLE:
    "Выбранный интервал уже недоступен. Список свободного времени обновлён; выберите другой интервал.",
};

function localDate(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function masterSummary(masters: MasterChoice[]) {
  return masters.length
    ? `Доступные мастера: ${masters.map((master) => master.name).join(", ")}.`
    : "Нет активных подходящих мастеров.";
}

function visitDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

function serviceSummary(service: { name: string; priceKopecks: number; durationMinutes: number }) {
  return `${service.name} · ${money(service.priceKopecks)} · ${service.durationMinutes} мин`;
}

export function AppointmentRescheduleEditor({
  appointment,
  form,
  href,
  saved,
}: {
  appointment: {
    id: string;
    version: number;
    serviceId: string;
    masterId: string;
    masterSelection: "SPECIFIC" | "ANY";
    startsAt: string;
    endsAt: string;
    serviceNameSnapshot: string;
    servicePriceSnapshot: number;
    serviceDurationSnapshot: number;
    master: { name: string };
  };
  form: {
    context: BusinessContext;
    services: CatalogService[];
    historicalMasters: MasterChoice[];
  };
  href: string;
  saved: boolean;
}) {
  const currentLocalDate = localDate(appointment.startsAt, form.context.timeZone);
  const initialDate = form.context.dates.includes(currentLocalDate)
    ? currentLocalDate
    : (form.context.dates[0] ?? "");
  const initialMaster =
    appointment.masterSelection === "ANY" && form.historicalMasters.length
      ? "ANY"
      : form.historicalMasters.some((master) => master.id === appointment.masterId)
        ? appointment.masterId
        : "";
  const [serviceChoice, setServiceChoice] = useState("KEEP_CURRENT");
  const [masterChoice, setMasterChoice] = useState(initialMaster);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [selectedStartsAt, setSelectedStartsAt] = useState("");
  const [availability, setAvailability] = useState<AvailabilityState>({ status: "idle" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const saveLock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  const catalogService = form.services.find((service) => service.id === serviceChoice);
  const selectedService =
    serviceChoice === "KEEP_CURRENT"
      ? {
          id: appointment.serviceId,
          name: appointment.serviceNameSnapshot,
          priceKopecks: appointment.servicePriceSnapshot,
          durationMinutes: appointment.serviceDurationSnapshot,
        }
      : catalogService;
  const availableMasters =
    serviceChoice === "KEEP_CURRENT" ? form.historicalMasters : (catalogService?.masters ?? []);
  const serviceInput: AppointmentServiceSelection | null =
    serviceChoice === "KEEP_CURRENT"
      ? { mode: "KEEP_CURRENT" }
      : catalogService
        ? {
            mode: "CATALOG",
            serviceId: catalogService.id,
            expectedServiceTerms: catalogService.termsHash,
          }
        : null;
  const masterInput =
    masterChoice === "ANY"
      ? ({ type: "ANY" } as const)
      : masterChoice
        ? ({ type: "SPECIFIC", masterId: masterChoice } as const)
        : null;
  const selectionKey = [
    serviceChoice,
    catalogService?.termsHash ?? "historical",
    masterChoice,
    selectedDate,
    form.context.contextHash,
  ].join("|");
  const currentAvailability =
    "key" in availability && availability.key === selectionKey ? availability : null;
  const selectedSlot =
    currentAvailability?.status === "ready"
      ? currentAvailability.slots.find((slot) => slot.startsAt === selectedStartsAt)
      : undefined;
  const blocked = failure
    ? blockingFailures.has(failure.code) &&
      !(failure.code === "UNAVAILABLE" && failure.phase === "availability")
    : false;
  const chosenMasterName =
    masterChoice === "ANY"
      ? "Любой свободный мастер"
      : availableMasters.find((master) => master.id === masterChoice)?.name;
  const oldMasterName =
    appointment.masterSelection === "ANY"
      ? `Любой свободный мастер (назначен: ${appointment.master.name})`
      : appointment.master.name;
  const serviceChanged =
    !!selectedService &&
    (appointment.serviceId !== selectedService.id ||
      appointment.serviceNameSnapshot !== selectedService.name ||
      appointment.servicePriceSnapshot !== selectedService.priceKopecks ||
      appointment.serviceDurationSnapshot !== selectedService.durationMinutes);
  const masterChanged =
    masterChoice === "ANY"
      ? appointment.masterSelection !== "ANY"
      : !!masterChoice &&
        (appointment.masterSelection !== "SPECIFIC" || appointment.masterId !== masterChoice);
  const timeChanged =
    !!selectedSlot &&
    (new Date(appointment.startsAt).getTime() !== new Date(selectedSlot.startsAt).getTime() ||
      new Date(appointment.endsAt).getTime() !== new Date(selectedSlot.endsAt).getTime());
  const hasRealChange = !!selectedSlot && (serviceChanged || masterChanged || timeChanged);
  const canLoad =
    !!serviceInput &&
    !!masterInput &&
    !!selectedDate &&
    !saving &&
    !blocked &&
    availability.status !== "loading";
  const canSave =
    !!serviceInput &&
    !!masterInput &&
    !!selectedSlot &&
    hasRealChange &&
    confirmed &&
    !saving &&
    !blocked;

  function focusFeedback() {
    requestAnimationFrame(() => feedback.current?.focus());
  }

  function invalidateSelection() {
    ++generation.current;
    setAvailability({ status: "idle" });
    setSelectedStartsAt("");
    setConfirmed(false);
    setFailure(null);
  }

  function mastersFor(choice: string) {
    return choice === "KEEP_CURRENT"
      ? form.historicalMasters
      : (form.services.find((service) => service.id === choice)?.masters ?? []);
  }

  function chooseService(choice: string) {
    const masters = mastersFor(choice);
    setServiceChoice(choice);
    setMasterChoice((current) => {
      if (current === "ANY" && masters.length) return current;
      if (masters.some((master) => master.id === current)) return current;
      return "";
    });
    invalidateSelection();
  }

  async function loadAvailability() {
    if (!canLoad || !serviceInput || !masterInput) return;
    const request = ++generation.current;
    const key = selectionKey;
    setFailure(null);
    setSelectedStartsAt("");
    setConfirmed(false);
    setAvailability({ status: "loading", key });
    try {
      const result = await getAppointmentRescheduleAvailabilityAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        service: serviceInput,
        master: masterInput,
        localDate: selectedDate,
        expectedBusinessContext: form.context.contextHash,
      });
      if (request !== generation.current) return;
      if (result.ok) {
        setAvailability({
          status: "ready",
          key,
          slots: result.slots,
          timeZone: result.timeZone,
        });
        return;
      }
      setAvailability({ status: "error", key });
      setFailure({ code: result.code, phase: "availability" });
      focusFeedback();
    } catch {
      if (request !== generation.current) return;
      setAvailability({ status: "error", key });
      setFailure({ code: "UNAVAILABLE", phase: "availability" });
      focusFeedback();
    }
  }

  async function save() {
    if (!canSave || !serviceInput || !masterInput || !selectedSlot || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const result = await rescheduleAppointmentAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        service: serviceInput,
        master: masterInput,
        localDate: selectedDate,
        startsAt: selectedSlot.startsAt,
        expectedBusinessContext: form.context.contextHash,
        confirmed: true,
      });
      if (result.ok) {
        const target = new URL(href, window.location.origin);
        target.searchParams.set("visitUpdated", "1");
        // A full navigation re-reads the appointment/version and creates a fresh CSP nonce.
        window.location.assign(target.pathname + target.search);
        return;
      }
      setFailure({ code: result.code, phase: "mutation" });
      if (result.code === "SLOT_UNAVAILABLE") {
        setSelectedStartsAt("");
        setConfirmed(false);
        setAvailability({
          status: "ready",
          key: selectionKey,
          slots: result.availability.slots,
          timeZone: result.availability.timeZone,
        });
      } else if (
        result.code === "SERVICE_TERMS_CHANGED" ||
        result.code === "BUSINESS_CONTEXT_CHANGED" ||
        result.code === "START_NOT_IN_FUTURE"
      ) {
        ++generation.current;
        setSelectedStartsAt("");
        setConfirmed(false);
        setAvailability({ status: "idle" });
      } else if (result.code === "NO_CHANGES") {
        setConfirmed(false);
      }
      focusFeedback();
    } catch {
      setFailure({ code: "UNAVAILABLE", phase: "mutation" });
      focusFeedback();
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  const slotTimeZone =
    currentAvailability?.status === "ready" ? currentAvailability.timeZone : form.context.timeZone;
  const oldService = useMemo(
    () =>
      serviceSummary({
        name: appointment.serviceNameSnapshot,
        priceKopecks: appointment.servicePriceSnapshot,
        durationMinutes: appointment.serviceDurationSnapshot,
      }),
    [
      appointment.serviceDurationSnapshot,
      appointment.serviceNameSnapshot,
      appointment.servicePriceSnapshot,
    ],
  );

  return (
    <section
      className="panel admin-form reschedule-editor"
      aria-labelledby="visit-parameters-title"
    >
      <h2 id="visit-parameters-title">Параметры визита</h2>
      {saved && (
        <p className="notice" role="status">
          Параметры визита сохранены. Карточка полностью перечитана.
        </p>
      )}
      <p className="hint">
        Перенос изменяет услугу, мастера и время только после отдельного подтверждения. Контакты и
        статус редактируются независимо.
      </p>
      <p className="notice reschedule-notification-warning">
        Автоматическое уведомление о переносе пока не отправляется. Свяжитесь с клиентом
        самостоятельно.
      </p>

      <form
        noValidate
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="catalog-fields" disabled={saving || blocked}>
          <legend className="sr-only">Редактор параметров визита</legend>

          <fieldset className="reschedule-group">
            <legend>Услуга и условия</legend>
            <div className="reschedule-options">
              <label className="reschedule-option">
                <input
                  type="radio"
                  name="visit-service"
                  value="KEEP_CURRENT"
                  checked={serviceChoice === "KEEP_CURRENT"}
                  onChange={() => chooseService("KEEP_CURRENT")}
                />
                <span>
                  <strong>Оставить текущую услугу и условия записи</strong>
                  <small>{oldService}</small>
                  <small>
                    KEEP_CURRENT · каталог не применяется; сохранённая длительность остаётся
                    исторической.
                  </small>
                  <small>{masterSummary(form.historicalMasters)}</small>
                </span>
              </label>
              {form.services.map((service) => (
                <label className="reschedule-option" key={service.id}>
                  <input
                    type="radio"
                    name="visit-service"
                    value={service.id}
                    checked={serviceChoice === service.id}
                    onChange={() => chooseService(service.id)}
                  />
                  <span>
                    <strong>Применить актуальную услугу: {service.name}</strong>
                    <small>{serviceSummary(service)}</small>
                    <small>CATALOG · будут применены текущие активные условия каталога.</small>
                    {service.id === appointment.serviceId && (
                      <small>
                        Это та же услуга по ID, но выбор применит её актуальные условия.
                      </small>
                    )}
                    <small>{masterSummary(service.masters)}</small>
                  </span>
                </label>
              ))}
            </div>
            {!form.services.length && (
              <p className="empty">В каталоге сейчас нет активных услуг.</p>
            )}
          </fieldset>

          <fieldset className="reschedule-group">
            <legend>Мастер</legend>
            <div className="reschedule-master-options">
              {!!availableMasters.length && (
                <label className="reschedule-master-option">
                  <input
                    type="radio"
                    name="visit-master"
                    value="ANY"
                    checked={masterChoice === "ANY"}
                    onChange={() => {
                      setMasterChoice("ANY");
                      invalidateSelection();
                    }}
                  />
                  <span>Любой свободный мастер (ANY)</span>
                </label>
              )}
              {availableMasters.map((master) => (
                <label className="reschedule-master-option" key={master.id}>
                  <input
                    type="radio"
                    name="visit-master"
                    value={master.id}
                    checked={masterChoice === master.id}
                    onChange={() => {
                      setMasterChoice(master.id);
                      invalidateSelection();
                    }}
                  />
                  <span>{master.name}</span>
                </label>
              ))}
            </div>
            {!availableMasters.length && (
              <p className="empty">Для выбранной услуги нет активных подходящих мастеров.</p>
            )}
            {!initialMaster && serviceChoice === "KEEP_CURRENT" && (
              <p className="notice">
                Текущего мастера нельзя выбрать заново: он неактивен или больше не назначен на эту
                услугу. Выберите доступного мастера либо вариант ANY.
              </p>
            )}
          </fieldset>

          <div className="reschedule-date-row">
            <label className="field" htmlFor="visit-local-date">
              Дата визита
              <select
                id="visit-local-date"
                value={selectedDate}
                onChange={(event) => {
                  setSelectedDate(event.target.value);
                  invalidateSelection();
                }}
              >
                {form.context.dates.map((date) => (
                  <option key={date} value={date}>
                    {calendarDate(date)}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              Даты и время показаны в часовом поясе бизнеса:{" "}
              <strong>{form.context.timeZone}</strong>.
            </p>
          </div>
          {currentLocalDate !== initialDate && (
            <p className="notice">
              Текущая дата визита находится вне действующего горизонта записи. Для переноса выберите
              доступную дату.
            </p>
          )}

          <div className="slots-heading">
            <h3>Свободное время</h3>
            <button
              className="secondary"
              type="button"
              disabled={!canLoad}
              onClick={loadAvailability}
            >
              {currentAvailability?.status === "loading"
                ? "Проверяем…"
                : currentAvailability?.status === "ready"
                  ? "Обновить время"
                  : "Показать свободное время"}
            </button>
          </div>
          {!serviceInput || !masterInput || !selectedDate ? (
            <p className="empty">
              Выберите услугу, мастера и дату, чтобы запросить свободное время.
            </p>
          ) : currentAvailability?.status === "loading" ? (
            <p className="empty" role="status">
              Проверяем свободное время…
            </p>
          ) : currentAvailability?.status === "error" ? (
            <p className="empty">Свободное время не загружено.</p>
          ) : currentAvailability?.status === "ready" && currentAvailability.slots.length ? (
            <div className="slots reschedule-slots" aria-label="Свободное время">
              {currentAvailability.slots.map((slot) => (
                <button
                  type="button"
                  key={slot.startsAt}
                  aria-pressed={selectedStartsAt === slot.startsAt}
                  className={selectedStartsAt === slot.startsAt ? "selected" : ""}
                  onClick={() => {
                    setSelectedStartsAt(slot.startsAt);
                    setConfirmed(false);
                    setFailure(null);
                    requestAnimationFrame(() => confirmation.current?.focus());
                  }}
                >
                  {time(slot.startsAt, slotTimeZone)}–{time(slot.endsAt, slotTimeZone)}
                </button>
              ))}
            </div>
          ) : currentAvailability?.status === "ready" ? (
            <p className="empty">На выбранную дату свободных интервалов нет.</p>
          ) : (
            <p className="empty">Свободное время ещё не запрошено.</p>
          )}

          {selectedSlot && selectedService && chosenMasterName && (
            <div
              ref={confirmation}
              tabIndex={-1}
              className="reschedule-confirmation"
              aria-labelledby="reschedule-confirmation-title"
            >
              <h3 id="reschedule-confirmation-title">Подтверждение переноса</h3>
              <div className="reschedule-comparison">
                <section aria-labelledby="reschedule-before-title">
                  <h4 id="reschedule-before-title">Было</h4>
                  <dl>
                    <div>
                      <dt>Услуга</dt>
                      <dd>{oldService}</dd>
                    </div>
                    <div>
                      <dt>Мастер</dt>
                      <dd>{oldMasterName}</dd>
                    </div>
                    <div>
                      <dt>Дата</dt>
                      <dd>{visitDate(appointment.startsAt, form.context.timeZone)}</dd>
                    </div>
                    <div>
                      <dt>Начало</dt>
                      <dd>{dateTime(appointment.startsAt, form.context.timeZone)}</dd>
                    </div>
                    <div>
                      <dt>Окончание</dt>
                      <dd>{dateTime(appointment.endsAt, form.context.timeZone)}</dd>
                    </div>
                  </dl>
                </section>
                <section aria-labelledby="reschedule-after-title">
                  <h4 id="reschedule-after-title">Станет</h4>
                  <dl>
                    <div>
                      <dt>Услуга</dt>
                      <dd>{serviceSummary(selectedService)}</dd>
                    </div>
                    <div>
                      <dt>Мастер</dt>
                      <dd>{chosenMasterName}</dd>
                    </div>
                    <div>
                      <dt>Дата</dt>
                      <dd>{visitDate(selectedSlot.startsAt, slotTimeZone)}</dd>
                    </div>
                    <div>
                      <dt>Начало</dt>
                      <dd>{dateTime(selectedSlot.startsAt, slotTimeZone)}</dd>
                    </div>
                    <div>
                      <dt>Окончание</dt>
                      <dd>{dateTime(selectedSlot.endsAt, slotTimeZone)}</dd>
                    </div>
                  </dl>
                </section>
              </div>
              {!hasRealChange && (
                <p className="notice">Выбранные параметры полностью совпадают с сохранёнными.</p>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!hasRealChange || saving || blocked}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Подтверждаю изменение параметров этого визита
              </label>
            </div>
          )}

          <button className="primary" type="submit" disabled={!canSave}>
            {saving ? "Сохраняем перенос…" : "Сохранить параметры визита"}
          </button>
        </fieldset>
      </form>

      <div ref={feedback} tabIndex={-1} className="reschedule-status" aria-live="assertive">
        {failure && (
          <p className="notice" role="alert">
            {failure.code === "UNAVAILABLE" && failure.phase === "availability"
              ? "Не удалось получить свободное время. Автоматического повтора не будет; повторите проверку вручную."
              : messages[failure.code]}
          </p>
        )}
        {blocked && failure && (
          <div className="reschedule-recovery">
            <a href={href} target="_blank" rel="noopener noreferrer">
              Сверить карточку в новой вкладке
            </a>
            <a href={href}>Полностью перечитать эту карточку</a>
            {failure.code === "UNAUTHORIZED" && (
              <a href="/admin/login" target="_blank" rel="noopener noreferrer">
                Войти заново
              </a>
            )}
          </div>
        )}
      </div>
      <p className="hint">
        Черновик существует только в памяти этой вкладки и исчезнет при полном перечитывании или
        уходе со страницы.
      </p>
    </section>
  );
}
