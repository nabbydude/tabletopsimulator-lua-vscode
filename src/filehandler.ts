import * as os from 'os';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as mkdirp from 'mkdirp';
import * as vscode from 'vscode';

export const ttsLuaDir = path.join(os.tmpdir(), 'TabletopSimulator', 'Tabletop Simulator Scripts');
export const docsFolder = path.join(os.homedir(), 'Documents', 'Tabletop Simulator');

export function tryCreateWorkspaceFolder() {
  try {
    if (!fse.existsSync(ttsLuaDir)) mkdirp.sync(ttsLuaDir);
  } catch (e) { console.error(`[TTSLua] Failed to create workspace folder: ${e}`); }
}

export function tryInstallConsole(extensionPath: string) {
  const consoleSrc = path.join(extensionPath, 'scripts');
  fse.copy(consoleSrc, docsFolder, (err: NodeJS.ErrnoException | null) => {
    if (err) {
      vscode.window.showErrorMessage(`[TTSLua] Console++ Installation Failed. ${err.message}`);
      if (err.code === 'EPERM') {
        vscode.window.showWarningMessage('[TTSLua] Try reinstalling Console++ with VSCode running as Administrator');
      }
    } else vscode.window.showInformationMessage('[TTSLua] Console++ Installation Successful');
  });
}

export class FileHandler {
  basename: string;

  tempFile: string;

  constructor(basename: string) {
    this.basename = basename;
    this.tempFile = path.normalize(path.join(ttsLuaDir, this.basename));
  }

  create(text: string) {
    const dirname = path.dirname(this.tempFile);
    mkdirp.sync(dirname);
    const file = fse.openSync(this.tempFile, 'w');
    fse.writeSync(file, text);
    fse.closeSync(file);
  }

  open() {
    return vscode.window.showTextDocument(vscode.Uri.file(this.tempFile), {
      preserveFocus: true,
      preview: false,
    });
  }
}
