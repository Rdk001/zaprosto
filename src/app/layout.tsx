/* Full navigation intentionally reloads the nonce-protected document and session recovery state. */
/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from "next";
import { SkipLink } from "../components/skip-link";
import "./globals.css";
export const metadata: Metadata = {
  title: "Запросто — онлайн-запись",
  description: "Выберите услугу, мастера и удобное время для визита в барбершоп.",
  referrer: "no-referrer",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <SkipLink />
        <header className="site-header">
          <a className="wordmark" href="/" aria-label="Запросто — на главную">
            запросто<span>•</span>
          </a>
          <span className="header-label">БАРБЕРШОП / ОНЛАЙН-ЗАПИСЬ</span>
          <span className="header-dot" aria-hidden="true" />
        </header>
        {children}
        <footer className="site-footer">
          <span>Запросто</span>
          <span>Ваше время. Ваш стиль.</span>
        </footer>
      </body>
    </html>
  );
}
