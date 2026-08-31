"use client";
import { useRef, useState, useTransition } from "react";
import { loginAdminAction } from "../../app/admin/actions";
import { LOGIN_FAILURE } from "../../modules/auth/policy";

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const busy = useRef(false);
  return (
    <form
      className="panel admin-form"
      aria-label="Вход администратора"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        setError("");
        const form = event.currentTarget;
        const data = new FormData(form);
        const input = { login: data.get("login"), password: data.get("password") };
        startTransition(async () => {
          try {
            const result = await loginAdminAction(input, "/admin");
            if (result.ok) {
              // Reload the full nonce-protected document and clear the login history entry.
              window.location.replace(result.redirectTo);
              return;
            }
            setError(
              result.code === "INVALID_CREDENTIALS"
                ? LOGIN_FAILURE
                : "Не удалось выполнить вход. Обновите страницу и попробуйте ещё раз.",
            );
          } catch {
            setError("Нет связи с сервером. Попробуйте ещё раз.");
          } finally {
            const password = form.elements.namedItem("password") as HTMLInputElement;
            password.value = "";
            busy.current = false;
          }
        });
      }}
    >
      <label className="field" htmlFor="admin-login">
        Логин
        <input
          id="admin-login"
          name="login"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={3}
          maxLength={64}
          readOnly={pending}
        />
      </label>
      <label className="field" htmlFor="admin-password">
        Пароль
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          maxLength={128}
          readOnly={pending}
          aria-describedby={error ? "login-error" : undefined}
        />
      </label>
      {error && (
        <p className="notice" id="login-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-footer">
        <button className="primary" type="submit" disabled={pending}>
          {pending ? "Входим…" : "Войти"}
        </button>
      </div>
      <p className="hint" role="status">
        {pending
          ? "Проверяем данные…"
          : "Доступ только для администратора. Для восстановления обратитесь к оператору установки."}
      </p>
    </form>
  );
}
