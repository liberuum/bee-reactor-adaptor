/**
 * Minimal structural types for the host's `window.ph` surface. The real
 * ReactorClient / IReactor / document-drive types live in the reactor
 * packages — this module's needs are narrow, so we declare only the
 * methods we actually call. Keeps the adapter loosely coupled to the
 * host's exact API while still staying `any`-free.
 */
/**
 * Narrow `globalThis` accessor — returns the host window when present,
 * `undefined` in non-browser contexts (Node tests, SSR).
 */
export function hostWindow() {
    return globalThis.window;
}
export function hostPh() {
    return hostWindow()?.ph;
}
//# sourceMappingURL=host-types.js.map