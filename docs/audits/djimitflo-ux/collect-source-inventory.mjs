// Static inventory; imports/API names prove wiring only, never runtime functionality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const [root, out] = process.argv.slice(2);
assert(root && out, 'Usage: node collect-source-inventory.mjs SOURCE_ROOT OUTPUT_JSON');
const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript');
const base = path.join(root, 'packages/dashboard/src');
const read = p => ts.createSourceFile(p, fs.readFileSync(p,'utf8'), ts.ScriptTarget.Latest, true, p.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
const app = read(path.join(base, 'App.tsx'));
const imports = new Map();
const walk = (n, f) => { f(n); ts.forEachChild(n,c=>walk(c,f)); };
walk(app, n => {
  if(ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
    for(const e of n.importClause.namedBindings.elements) imports.set(e.name.text,n.moduleSpecifier.text);
  if(ts.isVariableDeclaration(n) && n.initializer) {
    const m=n.initializer.getText(app).match(/import\(['"]([^'"]+)/);
    if(m) imports.set(n.name.getText(app),m[1]);
  }
});
const resolve = (from, spec) => ['.tsx','.ts','/index.tsx','/index.ts'].map(ext=>path.resolve(path.dirname(from),spec+ext)).find(p=>fs.existsSync(p));
function calls(file,seen=new Set()) {
  if(seen.has(file)) return [];
  seen.add(file); const sf=read(file); const rows=[];
  walk(sf,n=>{
    if(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf)==='api') {
      rows.push({file:path.relative(root,file),line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,method:n.expression.name.text,args:n.arguments.map(a=>a.getText(sf)).map(s=>s.slice(0,180))});
    }
    if((ts.isCallExpression(n)||ts.isNewExpression(n)) && ['authenticatedFetch','fetch','EventSource'].includes(n.expression.getText(sf))) {
      rows.push({file:path.relative(root,file),line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,method:n.expression.getText(sf),args:(n.arguments??[]).map(a=>a.getText(sf).slice(0,450))});
    }
  });
  for(const n of sf.statements) if(ts.isImportDeclaration(n) && n.moduleSpecifier.text.startsWith('.')) {
    const p=resolve(file,n.moduleSpecifier.text);
    if(p && p.startsWith(base) && !p.includes('/lib/api.') && !p.includes('/lib/store.') && !p.includes('/lib/auth-store.')) rows.push(...calls(p,seen));
  }
  return rows;
}
const api=read(path.join(base,'lib/api.ts'));const methods={};
walk(api,n=>{if(ts.isMethodDeclaration(n) && n.name){const endpoints=[];walk(n,c=>{
  if(ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && /request|fetch/.test(c.expression.name.text)) endpoints.push(c.arguments.map(a=>a.getText(api)).join(', ').slice(0,450));
});methods[n.name.getText(api)]={line:api.getLineAndCharacterOfPosition(n.getStart()).line+1,endpoints};}});
const routes=[];
walk(app,n=>{if(!(ts.isJsxSelfClosingElement(n)||ts.isJsxOpeningElement(n))||n.tagName.getText(app)!=='Route') return;
  const attrs=Object.fromEntries(n.attributes.properties.filter(ts.isJsxAttribute).map(a=>[a.name.getText(app),a.initializer?.getText(app)??true]));
  const route=attrs.index?'/':String(attrs.path??'').replace(/^"|"$/g,'');
  const element=String(attrs.element??'').match(/<([A-Za-z0-9]+)/)?.[1];
  const file=element&&imports.has(element)?resolve(path.join(base,'App.tsx'),imports.get(element)):null;
  const uses=file?calls(file):[];
  routes.push({route:route.startsWith('/')||route==='*'?route:'/'+route,element,file:file?path.relative(root,file):null,line:app.getLineAndCharacterOfPosition(n.getStart()).line+1,redirect:attrs.element?.includes('Navigate')?attrs.element:null,api:uses.map(c=>({...c,endpoint:methods[c.method]??null}))});
});
assert(routes.some(r=>r.route==='/configuration'&&r.api.some(c=>c.method==='getRuntimeConfig')));
assert(routes.some(r=>r.route==='/tasks/:taskId/review'));
assert(routes.some(r=>r.route==='/audit'&&r.api.some(c=>c.method==='authenticatedFetch')));
const publicFile=path.join(root,'packages/server/src/routes/explore-public.ts');
const publicSource=read(publicFile); const publicRoutes=[];
walk(publicSource,n=>{
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(publicSource)==='router'&&n.expression.name.text==='get'&&ts.isStringLiteral(n.arguments[0]))
    publicRoutes.push({route:'/explore'+n.arguments[0].text,method:'GET',file:path.relative(root,publicFile),line:publicSource.getLineAndCharacterOfPosition(n.getStart()).line+1});
});
assert.equal(publicRoutes.length,7);
fs.writeFileSync(out,JSON.stringify({source_sha:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),classification:'STATIC_WIRING_ONLY',limitations:['Dynamic URL expressions are source expressions, not executed requests.','WebSocket and shared bootstrap APIs are not duplicated per page.','Public routes are the additional Explore router linked by the UI; this is not an inventory of every backend endpoint.'],routes,publicRoutes},null,2)+'\n');
console.log(`${routes.length} route declarations inventoried`);
