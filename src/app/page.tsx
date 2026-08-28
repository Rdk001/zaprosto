export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section aria-labelledby="page-title" className="space-y-4">
        <p className="text-sm font-semibold tracking-[0.18em] text-stone-500 uppercase">
          Онлайн-запись
        </p>
        <h1 id="page-title" className="text-5xl font-bold tracking-tight text-stone-900">
          Запросто
        </h1>
        <p className="max-w-xl text-lg leading-8 text-stone-600">
          Каркас приложения запущен. Клиентская запись и административные функции появятся на
          следующих этапах.
        </p>
      </section>
    </main>
  );
}
