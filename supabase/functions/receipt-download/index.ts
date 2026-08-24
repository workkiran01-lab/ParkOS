// Returns a short-lived signed URL for a reservation's receipt PDF.
//
// Authorization is the receipts-table RLS: the caller's own token selects the
// row, so staff (org members) and the owning customer succeed and everyone else
// gets nothing. Only then does the service role mint the signed URL — needed
// because customers are not org members and cannot read Storage directly.
import {
  AuthenticationError,
  ConfigurationError,
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
  readJsonObject,
  readString,
} from '../_shared/http.ts'
import { getAuthenticatedClients } from '../_shared/supabase.ts'

const SIGNED_URL_TTL_SECONDS = 300

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return optionsResponse()
  if (request.method !== 'POST') return errorResponse('Use POST for this endpoint.', 405)

  try {
    const body = await readJsonObject(request)
    const reservationId = body ? readString(body.reservation_id) : null
    if (!isUuid(reservationId)) return errorResponse('Choose a valid reservation.', 400)

    const { userClient, adminClient } = await getAuthenticatedClients(request)

    // RLS decides visibility. Latest receipt wins if a reservation somehow has more.
    const { data: receipt, error: receiptError } = await userClient
      .from('receipts')
      .select('storage_path, receipt_number')
      .eq('reservation_id', reservationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (receiptError) return errorResponse('The receipt could not be looked up.', 500)
    if (!receipt) return errorResponse('No receipt is available for this reservation yet.', 404)

    const { data: signed, error: signError } = await adminClient.storage
      .from('receipts')
      .createSignedUrl(receipt.storage_path, SIGNED_URL_TTL_SECONDS, {
        download: `${receipt.receipt_number}.pdf`,
      })

    if (signError || !signed?.signedUrl)
      return errorResponse('The receipt link could not be created.', 502)

    return jsonResponse({ url: signed.signedUrl, receipt_number: receipt.receipt_number })
  } catch (error) {
    if (error instanceof AuthenticationError) return errorResponse(error.message, 401)
    if (error instanceof ConfigurationError) return errorResponse(error.message, 503)
    console.error('Unexpected receipt-download failure.')
    return errorResponse('The receipt link could not be created.', 500)
  }
})
