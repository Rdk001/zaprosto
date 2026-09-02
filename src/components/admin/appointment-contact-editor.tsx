"use client";

import { useRef, useState, useTransition } from "react";

import { updateAppointmentContactsAction } from "../../app/admin/appointment-actions";
import type { AppointmentFailure } from "../../modules/appointments/domain/admin-input";
import { normalizeRussianPhone } from "../../modules/booking/domain/phone";

const messages: Record<AppointmentFailure["code"], string> = {
  INVALID_INPUT: "Проверьте имя и телефон. Данные не сохранены.",
  UNAUTHORIZED: "Сеанс завершён или доступ отключён. Войдите в новой вкладке и сверьте карточку.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по основному адресу.",
  UNAVAILABLE:
    "Сохранение не подтверждено. Результат неизвестен. Черновик сохранён здесь. Не повторяйте запрос: сначала сверьте карточку в новой вкладке.",
  NOT_FOUND: "Запись не найдена. Сверьте журнал в новой вкладке.",
  CONFLICT:
    "Запись уже изменена. Черновик сохранён здесь, но старая версия не будет заменена автоматически. Сверьте карточку в новой вкладке.",
  EDIT_NOT_ALLOWED: "Отменённая запись хранится как историческая и не редактируется.",
  INVALID_TRANSITION: "Изменение записи больше не разрешено. Сверьте карточку в новой вкладке.",
  NOT_STARTED: "Операция недоступна.",
  CONFIRMATION_REQUIRED: "Операция требует подтверждения.",
  INVALID_DAY: "Не удалось определить границы локального дня.",
};

function normalizedPhone(value: string) {
  try {
    return normalizeRussianPhone(value);
  } catch {
    return null;
  }
}

export function AppointmentContactEditor({
  id,
  version,
  clientName,
  clientPhone,
  href,
  saved,
}: {
  id: string;
  version: number;
  clientName: string;
  clientPhone: string;
  href: string;
  saved: boolean;
}) {
  const [name, setName] = useState(clientName);
  const [phone, setPhone] = useState(clientPhone);
  const [failure, setFailure] = useState<AppointmentFailure | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);

  const canonicalName = name.trim();
  const canonicalPhone = normalizedPhone(phone);
  const nameError =
    canonicalName.length === 0
      ? "Укажите имя клиента."
      : canonicalName.length > 200
        ? "Имя должно содержать не более 200 символов."
        : null;
  const phoneError = canonicalPhone
    ? null
    : "Укажите российский номер с префиксом +7 или 8 и 11 цифрами.";
  const changed =
    !nameError && !phoneError && (canonicalName !== clientName || canonicalPhone !== clientPhone);
  const blocked =
    !!failure && !["INVALID_INPUT", "NOT_STARTED", "CONFIRMATION_REQUIRED"].includes(failure.code);

  return (
    <section className="panel admin-form" aria-labelledby="contacts-title">
      <h2 id="contacts-title">Имя и телефон клиента</h2>
      {saved && (
        <p className="notice" role="status">
          Имя и телефон клиента сохранены.
        </p>
      )}
      <p className="hint">
        Исправление контактов не меняет статус и не отправляет автоматическое уведомление.
      </p>
      <form
        noValidate
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy.current || blocked) return;
          if (nameError) {
            nameInput.current?.focus();
            return;
          }
          if (phoneError || !canonicalPhone) {
            phoneInput.current?.focus();
            return;
          }
          if (!changed) return;
          busy.current = true;
          setFailure(null);
          startTransition(async () => {
            try {
              const result = await updateAppointmentContactsAction({
                id,
                version,
                clientName: canonicalName,
                clientPhone: canonicalPhone,
              });
              if (result.ok) {
                const target = new URL(href, window.location.origin);
                target.searchParams.set("contactsUpdated", "1");
                // Full document navigation re-reads the card with a fresh CSP nonce.
                window.location.assign(target.pathname + target.search);
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
          <legend className="sr-only">Исправление имени и телефона клиента</legend>
          <label className="field" htmlFor="appointment-client-name">
            Имя клиента
          </label>
          <input
            ref={nameInput}
            id="appointment-client-name"
            className="appointment-contact-input"
            type="text"
            autoComplete="name"
            maxLength={201}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!blocked) setFailure(null);
            }}
            aria-invalid={!!nameError}
            aria-describedby="appointment-client-name-hint appointment-client-name-error"
          />
          <p id="appointment-client-name-hint" className="hint">
            Обязательное поле, до 200 символов. Пробелы по краям будут удалены.
          </p>
          <p id="appointment-client-name-error" className="field-error" aria-live="polite">
            {nameError}
          </p>

          <label className="field" htmlFor="appointment-client-phone">
            Телефон клиента
          </label>
          <input
            ref={phoneInput}
            id="appointment-client-phone"
            className="appointment-contact-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={64}
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              if (!blocked) setFailure(null);
            }}
            aria-invalid={!!phoneError}
            aria-describedby="appointment-client-phone-hint appointment-client-phone-result"
          />
          <p id="appointment-client-phone-hint" className="hint">
            Префикс +7 или 8; пробелы, скобки и дефисы допустимы.
          </p>
          <p
            id="appointment-client-phone-result"
            className={phoneError ? "field-error" : "hint"}
            aria-live="polite"
          >
            {phoneError ? phoneError : `Будет сохранён номер: ${canonicalPhone}`}
          </p>

          <button className="primary" type="submit" disabled={blocked || !changed}>
            Сохранить имя и телефон
          </button>
        </fieldset>
      </form>
      <div ref={feedback} tabIndex={-1} className="contact-status" aria-live="assertive">
        {pending && <p role="status">Сохраняем имя и телефон…</p>}
        {failure && (
          <p className="notice" role="alert">
            {messages[failure.code]}
          </p>
        )}
        {blocked && (
          <div className="contact-recovery">
            <a href={href} target="_blank" rel="noopener noreferrer">
              Сверить карточку (новая вкладка)
            </a>
            <a href={href}>Перечитать текущую карточку перед новой попыткой</a>
            {failure?.code === "UNAUTHORIZED" && (
              <a href="/admin/login" target="_blank" rel="noopener noreferrer">
                Войти заново
              </a>
            )}
          </div>
        )}
      </div>
      <p className="hint">
        Черновик хранится только в этой вкладке и теряется при перечитывании или уходе со страницы.
      </p>
    </section>
  );
}
