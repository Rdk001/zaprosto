import { redirect } from "next/navigation";
import { getAdminCatalog } from "../../server/admin/catalog";
import { AdminNavigation } from "./navigation";
import { CatalogEditor } from "./catalog-editor";
import { LogoutButton } from "./logout-button";

export async function CatalogPage({ kind }: { kind: "services" | "masters" }) {
  const result = await getAdminCatalog();
  if (!result.ok && result.code === "UNAUTHORIZED") redirect("/admin/login");
  return (
    <main id="main" tabIndex={-1} className="shell">
      <div className="catalog-shell">
        {result.ok ? (
          <>
            <AdminNavigation current={kind} />
            <div className="appointment-heading">
              <p className="eyebrow">ЗАПРОСТО / КАТАЛОГ</p>
              <h1>{kind === "services" ? "Услуги" : "Мастера"}</h1>
              <p>
                {kind === "services"
                  ? "Цена и длительность едины для всех мастеров."
                  : "Назначайте услуги и меняйте порядок мастеров в онлайн-записи."}
              </p>
            </div>
            <CatalogEditor kind={kind} initialCatalog={result.catalog} />
            <div className="form-footer">
              <LogoutButton />
            </div>
          </>
        ) : (
          <>
            <h1>Каталог временно недоступен</h1>
            <p role="alert">
              Не удалось проверить сеанс или прочитать данные. Обновите страницу позже.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
