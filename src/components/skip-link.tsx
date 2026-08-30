"use client";

export function SkipLink() {
  return (
    <button
      type="button"
      className="skip-link"
      aria-controls="main"
      onClick={() => {
        const main = document.getElementById("main");
        if (!main) return;
        // The fragment can be a protected-link secret. Never navigate to an anchor.
        main.focus({ preventScroll: true });
        main.scrollIntoView({ block: "start" });
      }}
    >
      К содержимому
    </button>
  );
}
