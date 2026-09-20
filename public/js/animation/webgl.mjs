// Whether this browser can draw the 3D view at all.
//
// Kept apart from renderer3d.mjs, which pulls in the whole 3D library: the page
// asks this before deciding to offer the view, without downloading anything.
// No vendor imports; the scope is injectable so plain Node can test it.

let cached;

export function isWebGL2Supported(scope = globalThis) {
  if (scope === globalThis && cached !== undefined) {
    return cached;
  }
  let supported;
  try {
    const canvas =
      typeof scope.OffscreenCanvas === 'function'
        ? new scope.OffscreenCanvas(1, 1)
        : scope.document?.createElement('canvas');
    supported = Boolean(canvas?.getContext('webgl2'));
  } catch {
    supported = false;
  }
  if (scope === globalThis) {
    cached = supported;
  }
  return supported;
}
