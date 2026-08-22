import { useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { tapTarget } from '@/lib/attendant-ui'

// Optional vehicle photo on check-in. Uses a plain file input with
// capture="environment" so a phone opens the rear camera. Uploads to the
// private vehicle-photos bucket under the org_id/ prefix (storage RLS enforces
// org scoping) and records a vehicle_photos row. Failure is surfaced but never
// blocks the check-in that already happened.
export function PhotoCapture({
  orgId,
  reservationId,
}: {
  orgId: string
  reservationId: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setError(null)

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg'
    const path = `${orgId}/${reservationId}/${crypto.randomUUID()}-${safeName}`

    const { error: uploadError } = await supabase.storage
      .from('vehicle-photos')
      .upload(path, file, { upsert: false })
    if (uploadError) {
      setBusy(false)
      setError('Photo upload failed. The check-in is still saved.')
      return
    }

    const { error: rowError } = await supabase.from('vehicle_photos').insert({
      org_id: orgId,
      reservation_id: reservationId,
      storage_path: path,
    })
    setBusy(false)
    if (rowError) {
      setError('Photo saved to storage but not recorded. The check-in is still saved.')
      return
    }
    setCount((c) => c + 1)
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFile}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className={`flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 font-medium ${tapTarget} disabled:opacity-50`}
      >
        <Camera className="size-5" />
        {busy
          ? 'Uploading…'
          : count > 0
            ? `Add another photo (${count} saved)`
            : 'Add photo (optional)'}
      </button>
      {error && <p className="text-base text-destructive">{error}</p>}
    </div>
  )
}
