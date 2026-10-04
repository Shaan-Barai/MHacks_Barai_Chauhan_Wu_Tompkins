/** Landing: the name and one way in. */
export function LandingPage({ onStart }: { onStart: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-cream px-4 text-ink">
      <h1 className="text-6xl font-bold tracking-tight sm:text-8xl">ScrapSaver</h1>
      <a
        href="/dashboard"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          onStart()
        }}
        className="mt-10 rounded-full bg-ink px-8 py-3 text-lg font-medium text-cream transition-opacity hover:opacity-80"
      >
        Get started
      </a>
    </main>
  )
}
