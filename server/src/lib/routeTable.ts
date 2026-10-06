import type { Express } from 'express';

/**
 * Every route an Express 4 app answers, read from its live router (not from source text), as
 * "METHOD /full/path". Used by the access matrix's coverage guard so a route can't escape
 * classification by how it is written.
 */
interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  handle?: { stack?: Layer[] };
}

/** "/api/voice" from a mounted router's matcher, e.g. /^\/api\/voice\/?(?=\/|$)/i. */
function mountPath(regexp: Layer['regexp']): string {
  if (!regexp || regexp.fast_slash) return '';
  return regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

function walk(stack: Layer[], prefix: string, out: string[]): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on && method !== '_all') out.push(`${method.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer.regexp), out);
    }
  }
}

export function listRoutes(app: Express): string[] {
  const out: string[] = [];
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '', out);
  return [...new Set(out)].sort();
}
