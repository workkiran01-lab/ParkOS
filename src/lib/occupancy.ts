// Week 11 live-occupancy helpers.
//
// The live status of a space is NOT spaces.status — nothing in the reservation
// lifecycle writes that column; it is only the admin-set baseline. A space is
// occupied/reserved because of an ACTIVE space_hold (released_at is null) whose
// `during` range contains now(). The space_holds exclusion constraint forbids
// two overlapping active holds on one space, so a space has at most ONE active
// hold covering now — no priority resolution is needed.

import type { SpaceStatus } from '@/lib/holds'

export type TileStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'maintenance'
  | 'permit'

export const tileStatuses: TileStatus[] = [
  'available',
  'occupied',
  'reserved',
  'permit',
  'maintenance',
]

/** The single active hold (if any) covering now for a space. */
export type ActiveHold = {
  hold_type: 'reservation' | 'permit' | 'maintenance' | 'block'
  /** For reservation holds, the referenced reservation's status — the only
   * thing that distinguishes an occupied (checked-in) space from a merely
   * reserved one. */
  reservationStatus?: string | null
}

/** Resolve the colour/status a tile should show right now. */
export function deriveTileStatus(
  baseline: SpaceStatus,
  activeHold: ActiveHold | undefined,
): TileStatus {
  if (activeHold) {
    if (activeHold.hold_type === 'maintenance' || activeHold.hold_type === 'block')
      return 'maintenance'
    if (activeHold.hold_type === 'permit') return 'permit'
    // reservation hold: checked-in (active) means occupied, otherwise reserved.
    return activeHold.reservationStatus === 'active' ? 'occupied' : 'reserved'
  }
  // No active hold covering now: fall back to the admin-set baseline.
  if (baseline === 'maintenance' || baseline === 'blocked') return 'maintenance'
  if (baseline === 'permit_assigned') return 'permit'
  return 'available'
}

/** Tailwind classes per tile status. Colours come from the --color-status-*
 * theme tokens (index.css); swap them there, never here. */
export const tileStatusClasses: Record<TileStatus, string> = {
  available: 'bg-status-available/15 text-status-available border-status-available/40',
  occupied: 'bg-status-occupied/20 text-status-occupied border-status-occupied/50',
  reserved: 'bg-status-reserved/20 text-status-reserved border-status-reserved/50',
  permit: 'bg-status-permit/15 text-status-permit border-status-permit/40',
  maintenance:
    'bg-status-maintenance/20 text-status-maintenance border-status-maintenance/50',
}

/** Solid swatch class, for the legend dots. */
export const tileStatusSwatch: Record<TileStatus, string> = {
  available: 'bg-status-available',
  occupied: 'bg-status-occupied',
  reserved: 'bg-status-reserved',
  permit: 'bg-status-permit',
  maintenance: 'bg-status-maintenance',
}

export const tileStatusLabel: Record<TileStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  reserved: 'Reserved',
  permit: 'Permit',
  maintenance: 'Maintenance',
}
