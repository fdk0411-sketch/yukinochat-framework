// Local, fixed asset namespace. Model output can never select resource paths.
const vendors = new Set(['pixi.min.js', 'unsafe-eval.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']);
export function live2dAssetForRoute(route) {
  const vendor = /^\/live2d\/vendor\/([a-z0-9.-]+)$/.exec(route);
  if (vendor && vendors.has(vendor[1])) return [`live2d/vendor/${vendor[1]}`, 'text/javascript; charset=utf-8'];
  if (!/^\/live2d\/yukino\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/){0,2}[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:json|moc3|png)$/.test(route)) return null;
  if (route.includes('..')) return null;
  return [route.slice(1), route.endsWith('.png') ? 'image/png' : route.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream'];
}
