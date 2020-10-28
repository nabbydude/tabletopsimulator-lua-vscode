/* eslint-disable import/no-dynamic-require */
/* eslint-disable global-require */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

function getNodeModulePath(moduleName: string) {
  return path.join(vscode.env.appRoot, 'node_modules.asar', moduleName);
}

function getNodeModule(moduleName: string) {
  return require(getNodeModulePath(moduleName));
}

const tm = getNodeModule('vscode-textmate');
const oniguruma = getNodeModule('vscode-oniguruma');

const grammarPaths: { [key: string]: any } = {
  'source.ttslua': path.join(__dirname, '../../syntaxes/ttslua.tmLanguage.json'),
};

const wasmBin = fs.readFileSync(path.join(getNodeModulePath('vscode-oniguruma'), 'release', 'onig.wasm')).buffer;
const vscodeOnigurumaLib = oniguruma.loadWASM(wasmBin).then(() => ({
  createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
  createOnigString: (s: string) => new oniguruma.OnigString(s),
}));

const registry = new tm.Registry({
  onigLib: vscodeOnigurumaLib,
  loadGrammar: (scopeName: any) => {
    const p: any = grammarPaths[scopeName];
    if (p) {
      return new Promise((c, e) => {
        fs.readFile(p, (error, content) => {
          if (error) {
            e(error);
          } else {
            const grammar = tm.parseRawGrammar(content.toString(), p);
            c(grammar);
          }
        });
      });
    }

    return null;
  },
});

let grammar: any = null;

export default async function getScopes(line: string, cursor: number): Promise<string[]> {
  if (!grammar) {
    grammar = await registry.loadGrammar('source.ttslua');
  }

  const r = grammar.tokenizeLine(line);
  const token: any = r.tokens.find((e: { startIndex: number; endIndex: number; }) => cursor >= e.startIndex && cursor < e.endIndex);

  if (token !== undefined) {
    return token.scopes;
  }
  return [];
}
