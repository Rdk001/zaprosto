import type { Metadata } from "next";
import { LoginForm } from "../../../components/admin/login-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Вход администратора — Запросто",
  robots: { index: false, follow: false },
};
export default function AdminLoginPage() {
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="admin-shell">
        <div className="appointment-heading">
          <p className="eyebrow">ЗАПРОСТО / АДМИНИСТРАТОР</p>
          <h1>Вход</h1>
          <p>Введите логин и пароль для доступа к административной части.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
