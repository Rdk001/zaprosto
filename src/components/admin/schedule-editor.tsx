"use client";
import { useRef, useState, useTransition } from "react";
import {
  saveWeekAction,
  saveExceptionAction,
  deleteExceptionAction,
} from "../../app/admin/schedule-actions";
import {
  MAX_DAY_INTERVALS,
  WEEKDAYS,
  type ScheduleFailure,
  type ScheduleInterval,
} from "../../modules/scheduling/domain/admin-input";
import type {
  AdminSchedule,
  AdminException,
  ScheduleMutationResult,
} from "../../modules/scheduling/server/admin-schedule";

const messages: Record<ScheduleFailure["code"], string> = {
  INVALID_INPUT: "Проверьте поля формы. Изменения не сохранены.",
  INVALID_TIME:
    "Время нельзя однозначно определить в часовом поясе бизнеса. Изменения не сохранены.",
  NOT_FOUND: "Мастер или исключение больше не найдены. Сверьте актуальные данные.",
  CONFLICT:
    "Данные изменились в другой вкладке или на эту дату уже есть исключение. Черновик сохранён здесь. Сверьте актуальный график, карточку и порядок мастера.",
  UNAUTHORIZED:
    "Сеанс завершён или доступ отключён. Войдите заново в другой вкладке и сверьте данные.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по основному адресу.",
  UNAVAILABLE:
    "Сохранение не подтверждено. Результат неизвестен. Не повторяйте запрос: сначала сверьте актуальные данные. Черновик остаётся здесь.",
  LIMIT_EXCEEDED:
    "Слишком много интервалов в сохранённых данных. Автоматическое обрезание запрещено; требуется проверка оператором.",
};
type ExceptionDraft = Omit<AdminException, "id"> & { id: string | null };
function IntervalRows({
  label,
  path,
  values,
  onChange,
  fields,
}: {
  label: string;
  path: string;
  values: ScheduleInterval[];
  onChange: (values: ScheduleInterval[]) => void;
  fields?: Record<string, string>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  return (
    <div ref={container} className="schedule-intervals">
      <h4>{label}</h4>
      {values.length === 0 && (
        <p className="hint">
          {label === "Работа"
            ? "Нет регулярных рабочих часов"
            : label === "Перерывы"
              ? "Нет перерывов"
              : "Добавьте рабочий интервал"}
        </p>
      )}
      {values.map((interval, index) => (
        <div className="schedule-interval" key={index}>
          {(["start", "end"] as const).map((key) => {
            const error = fields?.[`${path}.${index}.${key}`];
            const id = `${path}-${index}-${key}`;
            return (
              <label className="field" key={key} htmlFor={id}>
                <span>
                  {key === "start" ? "Начало" : "Конец"} {index + 1}
                </span>
                <input
                  id={id}
                  type="text"
                  placeholder="HH:mm"
                  maxLength={5}
                  value={interval[key]}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) =>
                    onChange(
                      values.map((row, i) =>
                        i === index ? { ...row, [key]: event.target.value } : row,
                      ),
                    )
                  }
                />
                {error && (
                  <span className="field-error" id={`${id}-error`}>
                    {error}
                  </span>
                )}
              </label>
            );
          })}
          <button
            type="button"
            className="secondary"
            aria-label={`Удалить ${label === "Работа" ? "рабочий интервал" : label === "Перерывы" ? "перерыв" : "особый интервал"} ${index + 1}`}
            onClick={() => {
              onChange(values.filter((_, i) => i !== index));
              requestAnimationFrame(() => add.current?.focus());
            }}
          >
            Удалить
          </button>
        </div>
      ))}
      <button
        ref={add}
        type="button"
        className="secondary"
        disabled={values.length >= MAX_DAY_INTERVALS}
        onClick={() => {
          onChange([...values, { start: "", end: "" }]);
          requestAnimationFrame(() =>
            container.current
              ?.querySelectorAll<HTMLInputElement>("input")
              [values.length * 2]?.focus(),
          );
        }}
      >
        Добавить{" "}
        {label === "Работа"
          ? "рабочий интервал"
          : label === "Перерывы"
            ? "перерыв"
            : "особый интервал"}
      </button>
      {values.length >= MAX_DAY_INTERVALS && (
        <p className="hint">Не более 16 интервалов одного типа на день.</p>
      )}
    </div>
  );
}
export function ScheduleEditor({
  initial,
}: {
  initial: AdminSchedule & { selected: NonNullable<AdminSchedule["selected"]> };
}) {
  const master = initial.selected;
  const [version, setVersion] = useState(master.version);
  const [days, setDays] = useState(master.days);
  const [exceptions, setExceptions] = useState(initial.exceptions);
  const [draft, setDraft] = useState<ExceptionDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<ScheduleFailure | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const status = useRef<HTMLDivElement>(null);
  const exceptionHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const blocked = Boolean(failure && !["INVALID_INPUT", "INVALID_TIME"].includes(failure.code));
  const currentUrl = `/admin/schedule?masterId=${master.id}&month=${initial.month}`;
  function run(operation: () => Promise<ScheduleMutationResult>, success: string) {
    if (busy.current || blocked) return;
    busy.current = true;
    setFailure(null);
    setMessage("");
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.ok) {
          setVersion(result.version);
          if (result.days) setDays(result.days);
          if (result.exception) {
            const saved = result.exception;
            setExceptions((rows) =>
              [
                ...rows.filter((row) => row.id !== saved.id),
                ...(saved.localDate.startsWith(initial.month) ? [saved] : []),
              ].sort((a, b) => a.localDate.localeCompare(b.localDate)),
            );
          }
          if (result.deletedId)
            setExceptions((rows) => rows.filter((row) => row.id !== result.deletedId));
          if (result.exception || result.deletedId) setDraft(null);
          setMessage(success);
        } else setFailure(result);
      } catch {
        setFailure({ ok: false, code: "UNAVAILABLE" });
      } finally {
        busy.current = false;
        requestAnimationFrame(() => status.current?.focus());
      }
    });
  }
  function edit(row?: AdminException, remove = false) {
    setDraft(
      row
        ? { ...row, intervals: row.intervals.map((interval) => ({ ...interval })) }
        : { id: null, localDate: "", type: "DAY_OFF", intervals: [] },
    );
    setDeleting(remove);
    setConfirmed(false);
    if (!blocked) {
      setFailure(null);
      setMessage("");
    }
    requestAnimationFrame(() => exceptionHeading.current?.focus());
  }
  return (
    <>
      <div ref={status} tabIndex={-1} className="catalog-status">
        {pending && !message && !failure && <p role="status">Сохраняем расписание…</p>}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {failure && (
          <div className="notice" role="alert">
            <p>{messages[failure.code]}</p>
            {failure.fields && (
              <ul>
                {Object.entries(failure.fields).map(([key, value]) => (
                  <li key={key}>
                    {key.startsWith("days.") ? `${WEEKDAYS[Number(key.split(".")[1])]}: ` : ""}
                    {value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {blocked && (
          <p>
            <a href={currentUrl} target="_blank" rel="noopener noreferrer">
              Проверить актуальное расписание (новая вкладка)
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
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          run(
            () => saveWeekAction({ masterId: master.id, version, days }),
            "Недельный график сохранён.",
          );
        }}
        aria-busy={pending}
      >
        <fieldset className="catalog-fields" disabled={pending}>
          <legend className="schedule-title">Недельный график</legend>
          <p className="hint">
            Пустой рабочий день не имеет регулярных часов. Перерывы сохраняются даже вне рабочих
            часов. Вводите HH:mm с точностью до минуты; ночные смены не поддерживаются.
          </p>
          <div className="schedule-week">
            {days.map((day, index) => (
              <fieldset key={day.dayOfWeek} className="panel schedule-day">
                <legend>{WEEKDAYS[day.dayOfWeek - 1]}</legend>
                {(["work", "breaks"] as const).map((kind) => (
                  <IntervalRows
                    key={kind}
                    label={kind === "work" ? "Работа" : "Перерывы"}
                    path={`days.${index}.${kind}`}
                    values={day[kind]}
                    fields={failure?.fields}
                    onChange={(values) =>
                      setDays((old) =>
                        old.map((row, i) => (i === index ? { ...row, [kind]: values } : row)),
                      )
                    }
                  />
                ))}
              </fieldset>
            ))}
          </div>
          <button className="primary" type="submit" disabled={blocked}>
            Сохранить неделю
          </button>
        </fieldset>
      </form>
      <section className="schedule-exceptions" aria-labelledby="exceptions-title">
        <h2 id="exceptions-title" ref={listHeading} tabIndex={-1}>
          Исключения на даты
        </h2>
        <p className="hint">
          Выходной полностью закрывает день. Особые часы заменяют недельные рабочие часы, но
          недельные перерывы продолжают действовать. После удаления исключения возвращается
          недельный график.
        </p>
        <form method="get" action="/admin/schedule" className="schedule-filter">
          <input type="hidden" name="masterId" value={master.id} />
          <label className="field">
            <span>Месяц исключений</span>
            <input type="month" name="month" defaultValue={initial.month} required />
          </label>
          <button className="secondary" type="submit">
            Показать месяц
          </button>
        </form>
        <p className="hint">
          Смена мастера, месяца или страницы сбрасывает несохранённый ввод. Для сравнения откройте
          данные в новой вкладке.
        </p>
        {!draft && (
          <button
            type="button"
            className="secondary"
            disabled={pending || blocked}
            onClick={() => edit()}
          >
            Добавить исключение
          </button>
        )}
        {!exceptions.length && (
          <p className="notice">В этом месяце исключений нет. Действует недельный график.</p>
        )}
        <ul className="catalog-list schedule-exception-list">
          {exceptions.map((row) => (
            <li className="panel catalog-row" key={row.id}>
              <div className="catalog-copy">
                <h3>
                  {row.localDate} · {row.type === "DAY_OFF" ? "Выходной" : "Особые часы"}
                </h3>
                {row.intervals.length > 0 && (
                  <p>{row.intervals.map((i) => `${i.start}–${i.end}`).join(", ")}</p>
                )}
              </div>
              <div className="catalog-controls">
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || blocked || draft !== null}
                  onClick={() => edit(row)}
                  aria-label={`Изменить исключение ${row.localDate}`}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || blocked || draft !== null}
                  onClick={() => edit(row, true)}
                  aria-label={`Удалить исключение ${row.localDate}`}
                >
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
        {draft && (
          <form
            className="panel admin-form"
            noValidate
            aria-busy={pending}
            onSubmit={(event) => {
              event.preventDefault();
              const target = { masterId: master.id, version };
              run(
                () =>
                  deleting
                    ? deleteExceptionAction({ ...target, id: draft.id, confirmed })
                    : saveExceptionAction({ ...target, ...draft }),
                deleting
                  ? "Исключение удалено. Снова действует недельный график."
                  : "Исключение сохранено. Список показывает выбранный месяц.",
              );
            }}
          >
            <h3 ref={exceptionHeading} tabIndex={-1}>
              {deleting
                ? "Удаление исключения"
                : draft.id
                  ? "Редактирование исключения"
                  : "Новое исключение"}
            </h3>
            <fieldset disabled={pending} className="catalog-fields">
              {deleting ? (
                <>
                  <p className="notice">
                    Удалить исключение на {draft.localDate}? После удаления снова действуют
                    недельные рабочие часы и перерывы. Существующие записи не изменятся.
                  </p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    Подтверждаю возврат к недельному графику
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Дата исключения</span>
                    <input
                      type="date"
                      value={draft.localDate}
                      max="9999-12-31"
                      min="0001-01-01"
                      aria-invalid={Boolean(failure?.fields?.localDate)}
                      onChange={(event) => setDraft({ ...draft, localDate: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Тип исключения</span>
                    <select
                      value={draft.type}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          type: event.target.value as ExceptionDraft["type"],
                          intervals: [],
                        })
                      }
                    >
                      <option value="DAY_OFF">Выходной</option>
                      <option value="CUSTOM_HOURS">Особые часы</option>
                    </select>
                  </label>
                  {draft.type === "CUSTOM_HOURS" && (
                    <IntervalRows
                      label="Особые часы"
                      path="intervals"
                      values={draft.intervals}
                      fields={failure?.fields}
                      onChange={(intervals) => setDraft({ ...draft, intervals })}
                    />
                  )}
                </>
              )}
              <div className="form-footer">
                <button
                  type="submit"
                  className="primary"
                  disabled={blocked || (deleting && !confirmed)}
                >
                  {deleting ? "Удалить и вернуть недельный график" : "Сохранить исключение"}
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    requestAnimationFrame(() => listHeading.current?.focus());
                  }}
                >
                  Закрыть без сохранения
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
    </>
  );
}
