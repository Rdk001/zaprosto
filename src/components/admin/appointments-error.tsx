/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation preserves nonce-CSP (ADR-0005). */
import type { AppointmentFailure } from "../../modules/appointments/domain/admin-input";
import { AdminNavigation } from "./navigation";
export function AppointmentsError({ code }: { code: AppointmentFailure["code"] }) {
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell">
        <AdminNavigation current="appointments" />
        <h1>Записи недоступны</h1>
        <p role="alert">
          {code === "INVALID_INPUT"
            ? "Проверьте дату, мастера, статус и страницу в адресе."
            : code === "NOT_FOUND"
              ? "Запись или мастер не найдены."
              : code === "INVALID_DAY"
                ? "Границы этого дня неоднозначны или не существуют в зоне бизнеса. Выберите другую дату; время автоматически не сдвигается."
                : "Не удалось проверить сеанс или прочитать записи. Повторите чтение позже."}
        </p>
        <a href="/admin/appointments">Открыть журнал заново</a>
      </div>
    </main>
  );
}
