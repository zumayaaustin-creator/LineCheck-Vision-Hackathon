/**
 * Shared HUD domain types.
 *
 * ContainerTarget is the shape SAM 3.1 returns per detected container/object and is also
 * the shape of the local mock cache, so mock and live paths stay swappable.
 */

export type ReticleStatus = 'nominal' | 'warning' | 'breach';

export interface ContainerTarget {
  id: string;
  label: string;
  /** Bounding box in HUD space (600x600) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 model confidence */
  confidence: number;
  /** Estimated fill level 0..100, for pan/prep-container checks */
  fillPercentage?: number;
  /** Resolved by the adapter, never optional: the HUD must always know how to colour it */
  status: ReticleStatus;
}
