import type { SupabaseClient } from '@supabase/supabase-js'
import type { DeliveryStatus } from './inbound'

/** Earlier statuses a report may replace; reports can arrive out of order and must never move a message backwards. */
const REPLACES: Record<DeliveryStatus, string[]> = {
  sent: ['sending'],
  delivered: ['sending', 'sent'],
  read: ['sending', 'sent', 'delivered'],
  failed: ['sending', 'sent'],
}

/**
 * Apply an MSG91 delivery report to the inbox copy of a message we sent.
 * `requestId` is the id MSG91's send API returned, which is what
 * persistOutbound stored as `message_id`. Returns how many rows changed.
 */
export async function applyDeliveryStatus(db: SupabaseClient, requestId: string, status: DeliveryStatus): Promise<number> {
  const { data, error } = await db
    .from('messages')
    .update({ status })
    .eq('message_id', requestId)
    .in('sender_type', ['bot', 'agent'])
    .in('status', REPLACES[status])
    .select('id')
  if (error) throw new Error(`delivery status update failed: ${error.message}`)
  return data?.length ?? 0
}
