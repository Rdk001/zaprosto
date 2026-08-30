"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="shell">
      <section className="panel recovery">
        <h1>Не удалось открыть страницу</h1>
        <p>
          Если вы отправляли запись, результат мог сохраниться. После перезагрузки проверьте
          предыдущую попытку.
        </p>
        <button className="primary" onClick={reset}>
          Попробовать снова
        </button>
      </section>
    </main>
  );
}
