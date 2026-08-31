"use client";
import { useRef, useState, useTransition } from "react";
import {
  saveMasterAction,
  saveServiceAction,
  moveCatalogAction,
} from "../../app/admin/catalog-actions";
import type { AdminCatalog } from "../../modules/catalog/server/admin-catalog";
import type { CatalogFailure } from "../../modules/catalog/domain/admin-input";

type Draft = {
  target: { id: string; version: number } | null;
  name: string;
  priceRubles: string;
  durationMinutes: string;
  description: string;
  isActive: boolean;
  wasActive: boolean;
  serviceIds: string[];
  confirmDeactivation: boolean;
};
const messages: Record<CatalogFailure["code"], string> = {
  INVALID_INPUT: "Проверьте поля формы.",
  NOT_FOUND: "Услуга или мастер больше не найдены. Проверьте актуальный список.",
  CONFLICT:
    "Данные изменились в другой вкладке. Ваш ввод сохранён здесь, но не записан. Откройте актуальный список и сравните изменения.",
  CONFIRM_REQUIRED: "Подтвердите деактивацию ниже.",
  UNAUTHORIZED:
    "Сеанс завершён или доступ отключён. Войдите заново, затем проверьте актуальный список.",
  FORBIDDEN: "Источник запроса не разрешён. Откройте приложение по его основному адресу.",
  UNAVAILABLE:
    "Сохранение не подтверждено. Результат неизвестен. Не повторяйте создание: сначала проверьте актуальный список.",
};
function rubles(kopecks: number) {
  return Math.floor(kopecks / 100) + "." + String(kopecks % 100).padStart(2, "0");
}
export function CatalogEditor({
  kind,
  initialCatalog,
}: {
  kind: "services" | "masters";
  initialCatalog: AdminCatalog;
}) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failure, setFailure] = useState<CatalogFailure | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const blocked =
    failure && ["UNAVAILABLE", "CONFLICT", "UNAUTHORIZED", "NOT_FOUND"].includes(failure.code);
  const rows = kind === "services" ? catalog.services : catalog.masters;
  function focus(ref: { current: HTMLElement | null }) {
    requestAnimationFrame(() => ref.current?.focus());
  }
  function edit(id?: string) {
    setFailure(null);
    setMessage("");
    const row = rows.find((item) => item.id === id);
    const service = catalog.services.find((item) => item.id === id);
    const master = catalog.masters.find((item) => item.id === id);
    setDraft({
      target: row ? { id: row.id, version: row.version } : null,
      name: row?.name ?? "",
      isActive: row?.isActive ?? true,
      wasActive: row?.isActive ?? false,
      priceRubles: service ? rubles(service.priceKopecks) : "",
      durationMinutes: service ? String(service.durationMinutes) : "",
      description: master?.description ?? "",
      serviceIds: master?.services.map((s) => s.serviceId) ?? [],
      confirmDeactivation: false,
    });
    focus(title);
  }
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  }
  function run(operation: () => ReturnType<typeof saveServiceAction>, success: string) {
    if (busy.current || blocked) return;
    busy.current = true;
    setFailure(null);
    setMessage("");
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.ok) {
          setCatalog(result.catalog);
          setDraft(null);
          setMessage(success);
          focus(status);
        } else {
          setFailure(result);
          focus(status);
        }
      } catch {
        setFailure({ ok: false, code: "UNAVAILABLE" });
        focus(status);
      } finally {
        busy.current = false;
      }
    });
  }
  const fieldError = (key: string) => failure?.fields?.[key];
  const errorProps = (key: string) => ({
    "aria-invalid": Boolean(fieldError(key)),
    "aria-describedby": fieldError(key) ? key + "-error" : undefined,
  });
  const errorText = (key: string) =>
    fieldError(key) ? (
      <span id={key + "-error"} className="field-error">
        {fieldError(key)}
      </span>
    ) : null;
  return (
    <>
      <div ref={status} tabIndex={-1} className="catalog-status">
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {failure && (
          <div className="notice" role="alert">
            <p>{messages[failure.code]}</p>
            {failure.fields?.form && <p>{failure.fields.form}</p>}
            {blocked && (
              <p>
                <a href={"/admin/" + kind} target="_blank" rel="noopener">
                  Проверить актуальный список (новая вкладка)
                </a>
              </p>
            )}
            {failure.code === "UNAUTHORIZED" && (
              <p>
                <a href="/admin/login" target="_blank" rel="noopener">
                  Войти в новой вкладке
                </a>
              </p>
            )}
          </div>
        )}
      </div>
      {draft ? (
        <form
          noValidate
          className="panel admin-form"
          aria-label={kind === "services" ? "Редактор услуги" : "Редактор мастера"}
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            const common = {
              target: draft.target,
              name: draft.name,
              isActive: draft.isActive,
              confirmDeactivation: draft.confirmDeactivation,
            };
            run(
              () =>
                kind === "services"
                  ? saveServiceAction({
                      ...common,
                      priceRubles: draft.priceRubles,
                      durationMinutes: draft.durationMinutes,
                    })
                  : saveMasterAction({
                      ...common,
                      description: draft.description,
                      serviceIds: draft.serviceIds,
                    }),
              "Сохранено. Каталог обновлён.",
            );
          }}
        >
          <h2 ref={title} tabIndex={-1}>
            {draft.target
              ? "Редактирование"
              : kind === "services"
                ? "Новая услуга"
                : "Новый мастер"}
          </h2>
          <fieldset disabled={pending} className="catalog-fields">
            <div className="field">
              <label htmlFor="catalog-name">{kind === "services" ? "Название" : "Имя"}</label>
              <input
                id="catalog-name"
                value={draft.name}
                maxLength={160}
                onChange={(e) => change("name", e.target.value)}
                {...errorProps("name")}
              />
              {errorText("name")}
            </div>
            {kind === "services" ? (
              <div className="catalog-pair">
                <div className="field">
                  <label htmlFor="catalog-price">Цена, ₽</label>
                  <input
                    id="catalog-price"
                    inputMode="decimal"
                    value={draft.priceRubles}
                    maxLength={12}
                    onChange={(e) => change("priceRubles", e.target.value)}
                    {...errorProps("priceRubles")}
                  />
                  {errorText("priceRubles")}
                  <span className="hint">Например, 1500,50. Не более двух знаков копеек.</span>
                </div>
                <div className="field">
                  <label htmlFor="catalog-duration">Длительность, минут</label>
                  <input
                    id="catalog-duration"
                    inputMode="numeric"
                    value={draft.durationMinutes}
                    maxLength={10}
                    onChange={(e) => change("durationMinutes", e.target.value)}
                    {...errorProps("durationMinutes")}
                  />
                  {errorText("durationMinutes")}
                  <span className="hint">Любое положительное целое число, например 35.</span>
                </div>
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="catalog-description">Описание</label>
                  <textarea
                    id="catalog-description"
                    rows={4}
                    value={draft.description}
                    maxLength={2000}
                    onChange={(e) => change("description", e.target.value)}
                    {...errorProps("description")}
                  />
                  {errorText("description")}
                </div>
                <fieldset className="assignments" aria-describedby="assignment-hint">
                  <legend>Назначенные услуги</legend>
                  <p id="assignment-hint" className="hint">
                    Выберите несколько услуг или оставьте список пустым. Без услуг мастер пока не
                    сможет принимать онлайн-записи. Неактивные назначения сохраняются.
                  </p>
                  {catalog.services.length === 0 && (
                    <p className="empty">Услуг пока нет. Их можно создать в разделе «Услуги».</p>
                  )}
                  {catalog.services.map((s) => (
                    <label key={s.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={draft.serviceIds.includes(s.id)}
                        onChange={(e) =>
                          change(
                            "serviceIds",
                            e.target.checked
                              ? [...draft.serviceIds, s.id]
                              : draft.serviceIds.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <span>
                        {s.name}
                        {!s.isActive && <span className="badge muted">Неактивна</span>}
                      </span>
                    </label>
                  ))}
                  {errorText("serviceIds")}
                </fieldset>
                {!draft.target && (
                  <p className="notice">
                    Новому мастеру не создаётся рабочий график. Свободные окна появятся после
                    настройки расписания в разделе «Расписание».
                  </p>
                )}
              </>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => {
                  change("isActive", e.target.checked);
                  change("confirmDeactivation", false);
                }}
              />
              {kind === "services" ? "Активна" : "Активен"}
            </label>
            {draft.wasActive && !draft.isActive && (
              <div className="notice">
                <p>
                  Деактивация ограничит новые онлайн-записи. Существующие записи не отменятся и не
                  перенесутся. Назначения сохранятся; активность можно вернуть.
                </p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.confirmDeactivation}
                    onChange={(e) => change("confirmDeactivation", e.target.checked)}
                  />
                  Подтверждаю деактивацию
                </label>
              </div>
            )}
          </fieldset>
          <div className="form-footer">
            <button type="submit" className="primary" disabled={pending || Boolean(blocked)}>
              {pending ? "Сохраняем…" : "Сохранить"}
            </button>
            <a
              className="secondary"
              href={"/admin/" + kind}
              aria-disabled={pending}
              onClick={(e) => {
                if (pending) e.preventDefault();
              }}
            >
              Закрыть редактор
            </a>
          </div>
          <p className="hint" role="status">
            {pending
              ? "Дождитесь результата. Не закрывайте страницу."
              : "Изменения каталога не меняют уже созданные записи."}
          </p>
        </form>
      ) : (
        <>
          <div className="catalog-toolbar">
            <p className="hint">{rows.length} в списке · неактивные тоже показаны</p>
            <button
              className="primary"
              disabled={pending || Boolean(blocked)}
              onClick={() => edit()}
            >
              {kind === "services" ? "Добавить услугу" : "Добавить мастера"}
            </button>
          </div>
          {rows.length === 0 && (
            <p className="empty">
              {kind === "services"
                ? "Услуг пока нет. Добавьте первую услугу."
                : "Мастеров пока нет. Добавьте первого мастера."}
            </p>
          )}
          <ol className="catalog-list">
            {rows.map((row, index) => (
              <li className="panel catalog-row" key={row.id}>
                <div className="catalog-copy">
                  <div className="catalog-row-title">
                    <h2>{row.name}</h2>
                    <span className={row.isActive ? "badge" : "badge muted"}>
                      {row.isActive ? "Активно" : "Неактивно"}
                    </span>
                  </div>
                  {"priceKopecks" in row ? (
                    <p>
                      {rubles(row.priceKopecks).replace(".", ",")} ₽ · {row.durationMinutes} мин
                    </p>
                  ) : (
                    <>
                      {row.description && <p className="catalog-description">{row.description}</p>}
                      <p className="hint">
                        {row.services.length
                          ? row.services
                              .map((s) => {
                                const service = catalog.services.find(
                                  (item) => item.id === s.serviceId,
                                );
                                return (
                                  (service?.name ?? "Услуга") +
                                  (service && !service.isActive ? " (неактивна)" : "")
                                );
                              })
                              .join(", ")
                          : "Нет назначенных услуг — онлайн-запись недоступна."}
                      </p>
                    </>
                  )}
                </div>
                <div className="catalog-controls">
                  <button
                    className="secondary"
                    disabled={pending || Boolean(blocked)}
                    aria-label={"Редактировать: " + row.name}
                    onClick={() => edit(row.id)}
                  >
                    Редактировать
                  </button>
                  {kind === "masters" && (
                    <a
                      className="secondary"
                      href={`/admin/schedule?masterId=${row.id}`}
                      aria-label={`Расписание: ${row.name}`}
                    >
                      Расписание
                    </a>
                  )}
                  <div className="catalog-move">
                    <button
                      className="secondary"
                      disabled={pending || Boolean(blocked) || index === 0}
                      aria-label={"Выше: " + row.name}
                      onClick={() =>
                        run(
                          () =>
                            moveCatalogAction({
                              kind,
                              id: row.id,
                              direction: "up",
                              orderVersion:
                                kind === "services"
                                  ? catalog.serviceOrderVersion
                                  : catalog.masterOrderVersion,
                            }),
                          "Порядок сохранён.",
                        )
                      }
                    >
                      ↑ Выше
                    </button>
                    <button
                      className="secondary"
                      disabled={pending || Boolean(blocked) || index === rows.length - 1}
                      aria-label={"Ниже: " + row.name}
                      onClick={() =>
                        run(
                          () =>
                            moveCatalogAction({
                              kind,
                              id: row.id,
                              direction: "down",
                              orderVersion:
                                kind === "services"
                                  ? catalog.serviceOrderVersion
                                  : catalog.masterOrderVersion,
                            }),
                          "Порядок сохранён.",
                        )
                      }
                    >
                      ↓ Ниже
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="hint">
            {kind === "masters"
              ? "Порядок используется в публичном каталоге и при равной нагрузке в выборе «Любого мастера»."
              : "В публичном каталоге показываются только активные услуги в этом порядке."}
          </p>
        </>
      )}
    </>
  );
}
