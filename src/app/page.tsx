/* Full navigation intentionally reloads the nonce-protected document and session recovery state. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { connection } from "next/server";
import { BookingFlow } from "../components/booking/booking-flow";
import { getPublicCatalog } from "../server/public/catalog";
export default async function Home() {
  await connection();
  let catalog;
  try {
    catalog = await getPublicCatalog();
  } catch {
    catalog = null;
  }
  if (!catalog)
    return (
      <main id="main" tabIndex={-1} className="shell">
        <section className="panel recovery">
          <p className="eyebrow">Онлайн-запись</p>
          <h1>Пока не можем показать расписание</h1>
          <p>
            Сервис временно недоступен или каталог ещё не настроен. Попробуйте открыть страницу
            позже.
          </p>
          <a className="primary" href="/">
            Обновить страницу
          </a>
        </section>
      </main>
    );
  return (
    <main id="main" tabIndex={-1} className="shell">
      <BookingFlow catalog={catalog} />
    </main>
  );
}
