const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const mkdirp = require('mkdirp');
const vscode = require('vscode');

const ttsLuaDir = path.join(os.tmpdir(), 'TabletopSimulator', 'Tabletop Simulator Scripts');
const docsFolder = path.join(os.homedir(), 'Documents', 'Tabletop Simulator');

export function tryCreateWorkspaceFolder() {
  try {
    if (!fs.existsSync(ttsLuaDir)) mkdirp.sync(ttsLuaDir);
  } catch (e) { console.error(`[TTSLua] Failed to create workspace folder: ${e}`); }
}

export function tryInstallConsole(extensionPath: string) {
  const consoleSrc = path.join(extensionPath, 'src', 'installScripts');
  fs.copy(consoleSrc, docsFolder, (err: any) => {
    if (err) console.error(`[TTSLua] Console++ Installation Failed. ${err}`);
    else vscode.window.showInformationMessage('Console++ Installation Successful');
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
    const file = fs.openSync(this.tempFile, 'w');
    fs.writeSync(file, text);
    fs.closeSync(file);
  }

  open() {
    return vscode.window.showTextDocument(vscode.Uri.file(this.tempFile), {
      preserveFocus: true,
      preview: false,
    });
  }
}
