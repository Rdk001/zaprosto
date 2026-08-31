"use client";
import { useState, useTransition } from "react";
import { logoutAdminAction } from "../../app/admin/actions";

export function LogoutButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  return (
    <div>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={() => {
          setError("");
          startTransition(async () => {
            try {
              const result = await logoutAdminAction();
              if (result.ok) {
                window.location.replace("/admin/login");
                return;
              }
            } catch {
              /* The server may be unavailable; never claim a revoked session. */
            }
            setError("Выход не подтверждён. Проверьте соединение и попробуйте ещё раз.");
          });
        }}
      >
        {pending ? "Выходим…" : "Выйти"}
      </button>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
