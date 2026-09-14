"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import {
  disconnectAppointmentTelegramAction,
  getAppointmentTelegramStateAction,
  issueAppointmentTelegramLinkAction,
  revokeAppointmentTelegramLinkAction,
} from "../../app/actions";
import {
  isCurrentTelegramRequest,
  mapTelegramIssueFailure,
  readIssuedTelegramLink,
  visibleTelegramLink,
  type AppointmentTelegramClientLink,
  type AppointmentTelegramUiState,
} from "./appointment-telegram-ui";

type BusyOperation = "ISSUE" | "REVOKE" | "DISCONNECT" | "REFRESH" | null;

export function AppointmentTelegramControls({ token }: { token: string }) {
  const [state, setState] = useState<AppointmentTelegramUiState | null>(null);
  const [link, setLink] = useState<AppointmentTelegramClientLink | null>(null);
  const [busy, setBusy] = useState<BusyOperation>("REFRESH");
  const [message, setMessage] = useState("");
  const [readFailed, setReadFailed] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const generation = useRef(0);
  const locked = useRef(false);

  const readState = useCallback(async (secret: string, request: number) => {
    try {
      const result = await getAppointmentTelegramStateAction(secret);
      if (!isCurrentTelegramRequest(request, generation.current)) return null;
      if (result.ok) {
        setState(result.state);
        setReadFailed(false);
        if (result.state !== "AVAILABLE") setLink(null);
        if (result.state !== "CONNECTED") setConfirmingDisconnect(false);
        return result.state;
      }
      setState(result.code === "UNAVAILABLE" ? null : "UNAVAILABLE");
      setReadFailed(result.code === "UNAVAILABLE");
      setLink(null);
      return null;
    } catch {
      if (!isCurrentTelegramRequest(request, generation.current)) return null;
      setState(null);
      setReadFailed(true);
      setLink(null);
      return null;
    }
  }, []);

  useEffect(() => {
    const load = () => {
      const request = ++generation.current;
      locked.current = false;
      setState(null);
      setLink(null);
      setMessage("");
      setReadFailed(false);
      setConfirmingDisconnect(false);
      setBusy("REFRESH");
      startTransition(async () => {
        await readState(token, request);
        if (isCurrentTelegramRequest(request, generation.current)) setBusy(null);
      });
    };
    load();
    return () => {
      generation.current += 1;
    };
  }, [readState, token]);

  function refresh() {
    if (locked.current) return;
    const request = ++generation.current;
    locked.current = true;
    setBusy("REFRESH");
    setMessage("");
    startTransition(async () => {
      await readState(token, request);
      if (isCurrentTelegramRequest(request, generation.current)) {
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
    startTransition(async () => {
      try {
        const result = await issueAppointmentTelegramLinkAction(token);
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        if (result.ok) {
          const issued = readIssuedTelegramLink(result, token);
          if (issued) {
            setLink(issued);
            setMessage(
              "Ссылка создана. Подключение завершится только после нажатия Start в Telegram.",
            );
            await readState(token, request);
          } else {
            setLink(null);
            setMessage("Результат не удалось подтвердить. Создайте новую ссылку.");
          }
        } else {
          const mapped = mapTelegramIssueFailure(result.code);
          setMessage(mapped.message);
          if (mapped.nextState) {
            setState(mapped.nextState);
            setLink(null);
          } else if (mapped.refresh) {
            await readState(token, request);
          }
        }
      } catch {
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        setLink(null);
        setMessage("Результат не удалось подтвердить. Обновите статус перед повтором.");
        await readState(token, request);
      } finally {
        if (isCurrentTelegramRequest(request, generation.current)) {
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
        const result = await revokeAppointmentTelegramLinkAction(token);
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        setLink(null);
        setMessage(
          result.ok
            ? "Неиспользованная ссылка отозвана."
            : "Ссылка больше недоступна. Проверяем актуальный статус.",
        );
        await readState(token, request);
      } catch {
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        setLink(null);
        setMessage("Результат отзыва неизвестен. Обновите статус перед повтором.");
        await readState(token, request);
      } finally {
        if (isCurrentTelegramRequest(request, generation.current)) {
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
        const result = await disconnectAppointmentTelegramAction(token);
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        setLink(null);
        setConfirmingDisconnect(false);
        const actual = await readState(token, request);
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        if (actual === "AVAILABLE" || actual === "UNAVAILABLE") {
          setMessage(
            result.ok
              ? result.alreadyDisconnected
                ? "Telegram уже был отключён. Статус обновлён."
                : "Telegram отключён. Неотправленные уведомления отменены."
              : "Telegram сейчас не подключён. Статус обновлён.",
          );
        } else if (!result.ok) {
          setMessage("Результат отключения неизвестен. Обновите статус и попробуйте снова.");
        }
      } catch {
        if (!isCurrentTelegramRequest(request, generation.current)) return;
        setMessage("Результат отключения неизвестен. Обновите статус и попробуйте снова.");
        await readState(token, request);
      } finally {
        if (isCurrentTelegramRequest(request, generation.current)) {
          locked.current = false;
          setBusy(null);
        }
      }
    });
  }

  const visibleLink = visibleTelegramLink(link, token);
  if (busy === "REFRESH" && state === null && !readFailed)
    return (
      <section className="panel" role="status">
        Проверяем доступность Telegram…
      </section>
    );
  if (state === "UNAVAILABLE") return null;
  if (state === null && readFailed)
    return (
      <section className="panel">
        <h2>Уведомления в Telegram</h2>
        <p>Сейчас не удалось проверить подключение. Это не влияет на вашу запись.</p>
        <button className="secondary" type="button" disabled={busy !== null} onClick={refresh}>
          Обновить статус
        </button>
      </section>
    );
  if (state === null) return null;

  return (
    <section className="panel">
      <div className="section-title">
        <h2>{state === "CONNECTED" ? "Telegram подключён" : "Уведомления в Telegram"}</h2>
        <button className="text-button" type="button" disabled={busy !== null} onClick={refresh}>
          Обновить статус
        </button>
      </div>
      {state === "CONNECTED" ? (
        confirmingDisconnect ? (
          <>
            <h3>Отключить Telegram?</h3>
            <p>Неотправленные уведомления для этой связи будут отменены.</p>
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
            <p>Уведомления для этой записи будут приходить в Telegram.</p>
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
      ) : visibleLink ? (
        <>
          <p>
            Ссылка действует до{" "}
            {new Intl.DateTimeFormat("ru-RU", {
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            }).format(visibleLink.expiresAt)}
            .
          </p>
          <a className="primary" href={visibleLink.url} target="_blank" rel="noreferrer">
            Открыть Telegram
          </a>
          <p>Нажмите Start в Telegram, затем вернитесь сюда и обновите статус.</p>
          <button className="text-button" type="button" disabled={busy !== null} onClick={revoke}>
            {busy === "REVOKE" ? "Отзываем ссылку…" : "Отозвать ссылку"}
          </button>
        </>
      ) : (
        <>
          <p>Подключите Telegram, чтобы получать уведомления об этой записи.</p>
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
