// Static declarations only. Runtime registration is checked separately against
// instantiated Express stacks; neither source references nor registration prove semantics.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import ts from 'typescript';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const joinPath = (...parts) => parts.join('/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
const literal = node => node && (ts.isStringLiteralLike(node)) ? node.text : undefined;

export function routeSourceFingerprint(root) {
  const hash = createHash('sha256');
  const paths = [
    ...readdirSync(join(root, 'packages/server/src/routes')).filter(file => file.endsWith('.ts')).map(file => `packages/server/src/routes/${file}`),
    'packages/server/src/utils/route-inventory.ts', 'packages/server/src/middleware/auth.ts',
  ].sort();
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  return hash.digest('hex');
}

export function inventoryRouteSource(root) {
  const directory = join(root, 'packages/server/src/routes');
  const definitions = [];
  const factories = new Map();
  const unsupported = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
    const module = basename(file, '.ts');
    const source = ts.createSourceFile(file, readFileSync(join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !literal(statement.moduleSpecifier)?.startsWith('./')) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) imports.set(binding.name.text, `${literal(statement.moduleSpecifier).slice(2).replace(/\.js$/, '')}:${binding.propertyName?.text ?? binding.name.text}`);
      }
    }
    function walk(node, owner) {
      if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith('create') && node.name.text.endsWith('Routes')) {
        owner = `${module}:${node.name.text}`;
        factories.set(owner, { routes: [], mounts: [] });
      }
      if (owner && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'router' && methods.has(node.expression.name.text)) {
        const method = node.expression.name.text.toUpperCase();
        const argument = node.arguments[0];
        const paths = argument && ts.isArrayLiteralExpression(argument) ? argument.elements.map(literal) : [literal(argument)];
        if (paths.some(path => path === undefined)) unsupported.push({ module, factory: owner, expression: node.expression.getText(source), reason: 'Nonliteral route path' });
        else for (const path of paths) {
          const entry = { id: `${module}:${method}:${path}`, module, factory: owner.split(':')[1], method, path };
          factories.get(owner).routes.push(entry);
          definitions.push(entry);
        }
      }
      if (owner && ts.isObjectLiteralExpression(node)) {
        const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(source), property.initializer]));
        const prefix = literal(properties.get('prefix'));
        const router = properties.get('router');
        if (prefix !== undefined && router && ts.isCallExpression(router)) {
          const name = router.expression.getText(source);
          factories.get(owner).mounts.push({ prefix, target: imports.get(name) ?? `${module}:${name}` });
        }
      }
      if (owner && ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression)) {
        const name = node.expression.expression.getText(source);
        if (/^create\w+Routes$/.test(name)) factories.get(owner).mounts.push({ prefix: '/', target: imports.get(name) ?? `${module}:${name}` });
      }
      ts.forEachChild(node, child => walk(child, owner));
    }
    walk(source);
  }
  const mounted = [];
  function expand(key, prefix, chain = []) {
    if (chain.includes(key)) throw new Error(`Cyclic route mount: ${key}`);
    const factory = factories.get(key);
    if (!factory) { unsupported.push({ factory: key, reason: 'Mount factory not resolved' }); return; }
    for (const route of factory.routes) mounted.push({ ...route, mounted_path: joinPath(prefix, route.path) });
    for (const mount of factory.mounts) expand(mount.target, joinPath(prefix, mount.prefix), [...chain, key]);
  }
  expand('index:createRoutes', '/api');
  const mountedIds = new Set(mounted.map(route => `${route.module}:${route.factory}:${route.method}:${route.path}`));
  return {
    definitions,
    mounted,
    outside_api_mount_graph: definitions.filter(route => !mountedIds.has(`${route.module}:${route.factory}:${route.method}:${route.path}`)),
    unsupported,
  };
}

export function compareRuntimeRoutes(source, runtime) {
  const key = route => `${route.method} ${route.mounted_path ?? route.path}`;
  const declared = new Set(source.mounted.map(key));
  const registered = new Set(runtime.map(key));
  return {
    declared_not_registered: [...declared].filter(route => !registered.has(route)).sort(),
    registered_not_declared: [...registered].filter(route => !declared.has(route)).sort(),
    unsupported_source: source.unsupported,
  };
}

export function inventoryDashboardClient(root, routes) {
  const file = 'packages/dashboard/src/lib/api.ts';
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const calls = [];
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === 'this.request') {
      const endpoint = node.arguments[0];
      let path = literal(endpoint);
      if (endpoint && ts.isTemplateExpression(endpoint)) {
        path = endpoint.head.text;
        for (const span of endpoint.templateSpans) {
          if (path.includes('?')) break;
          // Only a whole path segment is statically resolvable. Query suffixes
          // supplied as variables remain explicitly unresolved, not guessed.
          if (!path.endsWith('/')) { path = undefined; break; }
          path += `:dynamic${span.literal.text}`;
        }
      }
      const options = node.arguments[1];
      let method = 'GET';
      if (options) {
        if (!ts.isObjectLiteralExpression(options)) method = undefined;
        else {
          const methodProperty = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'method');
          if (methodProperty) method = literal(methodProperty.initializer)?.toUpperCase();
          if (options.properties.some(ts.isSpreadAssignment)) method = undefined;
        }
      }
      path = path?.split('?')[0];
      const normalize = value => joinPath(value).split('/').map(part => part.startsWith(':') ? ':' : part).join('/');
      const matches = path && method ? routes.filter(route => route.method === method && normalize(route.mounted_path ?? route.path) === normalize(`/api${path}`)).map(route => route.mounted_path ?? route.path) : [];
      calls.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: endpoint?.getText(source), method: method ?? null, path: path ?? null, matching_routes: matches, status: !path || !method ? 'DYNAMIC_UNRESOLVED' : matches.length ? 'REGISTERED_PATH_MATCH_ONLY' : 'NO_REGISTERED_MATCH' });
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return { scope: 'Dashboard API class this.request calls only; excludes direct fetch/auth/other clients and response schemas.', calls };
}
