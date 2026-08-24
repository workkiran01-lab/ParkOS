import { useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { edgeFunctionError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

/**
 * Fetches a short-lived signed URL for a reservation's receipt PDF and opens it.
 * Shown to staff and to the owning customer once payment has settled; the
 * receipt-download function enforces access via RLS.
 */
export function DownloadReceiptButton({ reservationId }: { reservationId: string }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    const { data, error } = await supabase.functions.invoke<{ url?: string }>(
      'receipt-download',
      { body: { reservation_id: reservationId } },
    )
    setBusy(false)

    if (error || !data?.url) {
      toast.error(
        await edgeFunctionError(error, 'No receipt is available for this reservation yet.'),
      )
      return
    }
    window.open(data.url, '_blank', 'noopener')
  }

  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={download}>
      <Download data-icon="inline-start" />
      {busy ? 'Fetching…' : 'Receipt'}
    </Button>
  )
}
