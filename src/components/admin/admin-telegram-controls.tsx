"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  disconnectAdminTelegramAction,
  getAdminTelegramStateAction,
  issueAdminTelegramLinkAction,
  revokeAdminTelegramLinkAction,
} from "../../app/admin/notifications-actions";
import {
  createAdminTelegramUiModel,
  isCurrentAdminTelegramRequest,
  mapAdminTelegramIssueFailure,
  readIssuedAdminTelegramLink,
  type AdminTelegramClientLink,
  type AdminTelegramUiState,
} from "./admin-telegram-ui";

type BusyOperation = "ISSUE" | "REVOKE" | "DISCONNECT" | "REFRESH" | null;

export function AdminTelegramControls({
  initialState,
  initialReadFailed = false,
}: {
  initialState: AdminTelegramUiState | null;
  initialReadFailed?: boolean;
}) {
  const initial = createAdminTelegramUiModel(initialState);
  const [state, setState] = useState<AdminTelegramUiState | null>(initial.state);
  const [link, setLink] = useState<AdminTelegramClientLink | null>(initial.link);
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [message, setMessage] = useState("");
  const [readFailed, setReadFailed] = useState(initialReadFailed);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<boolean>(
    initial.confirmingDisconnect,
  );
  const generation = useRef(0);
  const locked = useRef(false);

  useEffect(
    () => () => {
      generation.current += 1;
      locked.current = true;
    },
    [],
  );

  const loginAgain = useCallback(() => {
    generation.current += 1;
    locked.current = true;
    setLink(null);
    window.location.replace("/admin/login");
  }, []);

  const readState = useCallback(
    async (request: number) => {
      try {
        const result = await getAdminTelegramStateAction();
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return null;
        if (result.ok) {
          setState(result.state);
          setReadFailed(false);
          if (result.state !== "AVAILABLE") setLink(null);
          if (result.state !== "CONNECTED") setConfirmingDisconnect(false);
          return result.state;
        }
        if (result.code === "UNAUTHORIZED") {
          loginAgain();
          return null;
        }
        setState(null);
        setReadFailed(true);
        setLink(null);
        return null;
      } catch {
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return null;
        setState(null);
        setReadFailed(true);
        setLink(null);
        return null;
      }
    },
    [loginAgain],
  );

  function refresh() {
    if (locked.current) return;
    const request = ++generation.current;
    locked.current = true;
    setBusy("REFRESH");
    setMessage("");
    startTransition(async () => {
      await readState(request);
      if (isCurrentAdminTelegramRequest(request, generation.current)) {
        locked.current = false;
        setBusy(null);
      }
    });
  }

  function issue() {
    if (locked.current) return;
    const request = ++generation.current;
    locked.current = true;
    setBusy("ISSUE");
    setMessage("");
    setLink(null);
    startTransition(async () => {
      try {
        const result = await issueAdminTelegramLinkAction();
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        if (result.ok) {
          const issued = readIssuedAdminTelegramLink(result);
          if (issued) {
            setLink(issued);
            setMessage(
              "Ссылка создана. Подключение завершится только после нажатия Start в Telegram.",
            );
            await readState(request);
          } else {
            setMessage("Результат не удалось подтвердить. Создайте новую ссылку.");
          }
        } else {
          const mapped = mapAdminTelegramIssueFailure(result.code);
          if (mapped.unauthorized) {
            loginAgain();
            return;
          }
          setMessage(mapped.message);
          if (mapped.nextState) {
            setState(mapped.nextState);
            setLink(null);
          } else if (mapped.refresh) {
            await readState(request);
          }
        }
      } catch {
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        setLink(null);
        setMessage("Результат не удалось подтвердить. Обновите статус перед повтором.");
        await readState(request);
      } finally {
        if (isCurrentAdminTelegramRequest(request, generation.current)) {
          locked.current = false;
          setBusy(null);
        }
      }
    });
  }

  function revoke() {
    if (locked.current) return;
    const request = ++generation.current;
    locked.current = true;
    setBusy("REVOKE");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await revokeAdminTelegramLinkAction();
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        if (!result.ok && result.code === "UNAUTHORIZED") {
          loginAgain();
          return;
        }
        setLink(null);
        setMessage(
          result.ok
            ? "Неиспользованная ссылка отозвана."
            : "Результат отзыва неизвестен. Проверяем актуальный статус.",
        );
        await readState(request);
      } catch {
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        setLink(null);
        setMessage("Результат отзыва неизвестен. Обновите статус перед повтором.");
        await readState(request);
      } finally {
        if (isCurrentAdminTelegramRequest(request, generation.current)) {
          locked.current = false;
          setBusy(null);
        }
      }
    });
  }

  function disconnect() {
    if (locked.current || !confirmingDisconnect) return;
    const request = ++generation.current;
    locked.current = true;
    setBusy("DISCONNECT");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await disconnectAdminTelegramAction();
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        if (!result.ok && result.code === "UNAUTHORIZED") {
          loginAgain();
          return;
        }
        setLink(null);
        setConfirmingDisconnect(false);
        const actual = await readState(request);
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        if (result.ok && (actual === "AVAILABLE" || actual === "UNAVAILABLE")) {
          setMessage(
            result.alreadyDisconnected
              ? "Telegram уже был отключён. Статус обновлён."
              : "Telegram отключён. Неотправленные уведомления отменены.",
          );
        } else if (!result.ok && (actual === "AVAILABLE" || actual === "UNAVAILABLE")) {
          setMessage("Подключение сейчас не активно. Статус обновлён.");
        } else if (!result.ok) {
          setMessage("Результат отключения неизвестен. Обновите статус и попробуйте снова.");
        }
      } catch {
        if (!isCurrentAdminTelegramRequest(request, generation.current)) return;
        setMessage("Результат отключения неизвестен. Обновите статус и попробуйте снова.");
        await readState(request);
      } finally {
        if (isCurrentAdminTelegramRequest(request, generation.current)) {
          locked.current = false;
          setBusy(null);
        }
      }
    });
  }

  if (state === null && readFailed)
    return (
      <section className="panel">
        <h2>Уведомления в Telegram</h2>
        <p>Сейчас не удалось проверить подключение. Обновите статус позже.</p>
        <button className="secondary" type="button" disabled={busy !== null} onClick={refresh}>
          {busy === "REFRESH" ? "Проверяем…" : "Обновить статус"}
        </button>
        <p role="status" />
      </section>
    );

  if (state === null)
    return (
      <section className="panel" role="status">
        Проверяем доступность Telegram…
      </section>
    );

  return (
    <section className="panel">
      <div className="section-title">
        <h2>
          {state === "CONNECTED"
            ? "Telegram подключён"
            : state === "UNAVAILABLE"
              ? "Telegram временно недоступен"
              : "Уведомления в Telegram"}
        </h2>
        <button className="text-button" type="button" disabled={busy !== null} onClick={refresh}>
          {busy === "REFRESH" ? "Проверяем…" : "Обновить статус"}
        </button>
      </div>
      {state === "CONNECTED" ? (
        confirmingDisconnect ? (
          <>
            <h3>Отключить Telegram?</h3>
            <p>Неотправленные уведомления для этого подключения будут отменены.</p>
            <div className="form-footer">
              <button
                className="text-button"
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmingDisconnect(false)}
              >
                Оставить подключение
              </button>
              <button
                className="primary danger"
                type="button"
                disabled={busy !== null}
                onClick={disconnect}
              >
                {busy === "DISCONNECT" ? "Отключаем…" : "Да, отключить Telegram"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>Административные уведомления будут приходить в Telegram.</p>
            <button
              className="secondary danger"
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Отключить Telegram
            </button>
          </>
        )
      ) : state === "UNAVAILABLE" ? (
        <p>Подключение сейчас недоступно. Это не влияет на работу административной панели.</p>
      ) : link ? (
        <>
          <p>
            Ссылка действует до{" "}
            {new Intl.DateTimeFormat("ru-RU", {
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            }).format(link.expiresAt)}
            .
          </p>
          <a className="primary" href={link.url} target="_blank" rel="noreferrer">
            Открыть Telegram
          </a>
          <p>Нажмите Start в Telegram, затем вернитесь сюда и обновите статус.</p>
          <button className="text-button" type="button" disabled={busy !== null} onClick={revoke}>
            {busy === "REVOKE" ? "Отзываем ссылку…" : "Отозвать ссылку"}
          </button>
        </>
      ) : (
        <>
          <p>Подключите Telegram, чтобы получать административные уведомления.</p>
          <button className="secondary" type="button" disabled={busy !== null} onClick={issue}>
            {busy === "ISSUE" ? "Создаём ссылку…" : "Подключить Telegram"}
          </button>
        </>
      )}
      <p role="status" className={message ? "notice" : ""}>
        {message}
      </p>
    </section>
  );
}
