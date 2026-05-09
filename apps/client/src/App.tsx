import './App.css'
import WebsiteEvolutionViewer from './WebsiteEvolutionViewer'

function App() {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: "var(--reel-bg)",
        color: "var(--reel-paper)",
      }}
    >
      {/* Ambient radial glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 20% 10%, rgba(212,162,76,0.12), transparent 50%), radial-gradient(ellipse at 80% 80%, rgba(139,106,61,0.08), transparent 50%)",
        }}
      />
      <div className="relative z-10 min-h-screen flex flex-col">
        <header className="px-8 py-6 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <span
              className="font-serif text-base tracking-[0.3em] uppercase"
              style={{ color: "var(--reel-amber)" }}
            >
              Webrewind
            </span>
            <span className="text-[10px] uppercase tracking-[0.4em] opacity-50 font-serif">
              The Archive
            </span>
          </div>
          <a
            href="https://web.archive.org"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] uppercase tracking-[0.3em] opacity-50 hover:opacity-90 transition-opacity font-serif"
          >
            Powered by Wayback Machine ↗
          </a>
        </header>

        <main className="flex-1 flex items-stretch w-full">
          <WebsiteEvolutionViewer />
        </main>

        <footer
          className="px-8 py-4 text-[10px] uppercase tracking-[0.3em] opacity-40 font-serif text-center"
          style={{ borderTop: "1px solid rgba(139,106,61,0.18)" }}
        >
          A cinematic tour of the web, year by year
        </footer>
      </div>
    </div>
  )
}

export default App
