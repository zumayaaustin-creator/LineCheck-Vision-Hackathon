/**
 * Pure constants with no `import.meta` access, so modules that only need geometry
 * (normalise, the self-test, node-side tests) can be imported outside a bundler.
 */

/** Fixed HUD canvas edge, in pixels. All detection geometry is normalised into this space. */
export const HUD_SIZE = 600;
