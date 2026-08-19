type SpinnerProps = {
  className?: string
}

export function Spinner({ className = 'size-6' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 ${className}`}
    />
  )
}

export function PageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="size-8" />
    </div>
  )
}
