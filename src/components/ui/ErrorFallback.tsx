type ErrorFallbackProps = {
  error: Error
}

export function ErrorFallback({ error }: ErrorFallbackProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <h1 className="text-3xl font-bold tracking-tight">
        Something went wrong
      </h1>
      <p className="max-w-md text-center text-sm text-gray-500">
        {error.message}
      </p>
      <button
        type="button"
        onClick={() => window.location.assign('/')}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
      >
        Back to home
      </button>
    </main>
  )
}
