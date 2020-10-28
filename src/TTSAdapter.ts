/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-param-reassign */
import * as net from 'net';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import bundle from 'luabundle';
import parse from './bbcode/tabletop';
import { ttsLuaDir, docsFolder, FileHandler } from './filehandler';

interface TtsMessage {
  messageID: number,
  scriptStates?: ScriptState[],
  message?: string,
  error?: string,
  guid?: string,
  errorMessagePrefix?: string,
  customMessage?: object,
  returnValue?: boolean,
  script?: string
}

interface ScriptState {
  name: string,
  guid: string,
  script: string,
  ui?: string
}

function getSearchPaths(): string[] {
  const paths: string[] = [];
  const includeOtherFilesPath = vscode.workspace.getConfiguration('TTSLua').get('includeOtherFilesPaths') as string;
  const bundleSearchPath = vscode.workspace.getConfiguration('TTSLua').get('bundleSearchPath') as string;
  bundleSearchPath.split(';').map((pattern) => [
    path.join(ttsLuaDir, pattern),
    path.join(docsFolder, pattern),
    ...includeOtherFilesPath.split(';').map((p) => path.join(p, pattern)) || null,
  ]).map((combo) => paths.push(...combo));
  return paths;
}

export default class TTSAdapter {
  private dir: any;

  private disposables: any = [];

  private extensionPath: string;

  private ttsMsg: { [key: string]: number } = { // Poor man's enum
    pushObject: 0,
    NewGame: 1,
    Print: 2,
    Error: 3,
    Custom: 4,
    Return: 5,
    GameSaved: 6,
    ObjectCreated: 7,
  };

  private timeout: NodeJS.Timeout;

  private savedAndPlayed: boolean = true;

  private server: any;

  private executeWhenDone = () => { };

  private webviewPanel: any;

  constructor(extensionPath: string) {
    this.dir = vscode.Uri.file(ttsLuaDir);
    this.extensionPath = extensionPath;

    this.timeout = setTimeout(() => {
      this.savedAndPlayed = false;
    }, 3000);
    this.initServer();
  }

  initServer() {
    // Initialize Server for incoming TTS Messages
    this.server = net.createServer((socket: net.Socket) => {
      const chunks: any = [];
      // Set timeout in case of unexpected connection drop
      socket.setTimeout(10000);
      socket.on('timeout', () => socket.end());
      socket.on('end', () => {
        const input = Buffer.concat(chunks);
        this.handleMessage(JSON.parse(input.toString()) as TtsMessage);
        socket.end();
      }); // Normal disconnect after data read
      socket.on('data', (chunk) => chunks.push(chunk));
    });
    this.server.on('listening', () => console.debug('[TTSLua] Server open.'));
    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error('[TTSLua] Port 39998 is in use, retrying...');
        setTimeout(() => {
          this.server.close();
          this.server.listen(39998);
        }, 1000);
      } else console.error(`[TTSLua] Error: ${err}`);
    });
    this.server.listen(39998); // Open Server
  }

  getScripts() {
    const vsFolders = vscode.workspace.workspaceFolders;
    if (!vsFolders || vsFolders.findIndex((val) => val.uri.fsPath === this.dir.fsPath) === -1) {
      vscode.workspace.updateWorkspaceFolders(vsFolders ? vsFolders.length : 0, null, { uri: this.dir });
    }
    TTSAdapter.sendToTTS(0);
  }

  saveAndPlay() {
    const vsFolders = vscode.workspace.workspaceFolders;
    if (!vsFolders || vsFolders.findIndex((val) => val.uri.fsPath === this.dir.fsPath) === -1) {
      vscode.window.showErrorMessage('The workspace is not opened on the Tabletop Simulator folder.\nGet Lua Scripts from game before trying to Save and Play.');
      return;
    }
    vscode.workspace.saveAll(false).then(async () => {
      const objects = new Map();
      try {
        fs.readdirSync(ttsLuaDir).forEach((file) => {
          const filePath = path.join(ttsLuaDir, file);
          if (!fs.statSync(filePath).isDirectory()) {
            const tokens = file.split('.');
            const name = tokens[0];
            const guid = tokens[1];
            // If guid is not present in objects, create placeholder
            if (!objects.has(guid)) {
              objects.set(guid, {
                name, guid, script: '', ui: '',
              });
            }
            // Complete the object placeholder with the content of the file
            if (filePath.endsWith('.ttslua')) {
              const obj = objects.get(guid);
              // include system
              const luaScript = fs.readFileSync(filePath, 'utf8');
              // obj.script = vscode.workspace.getConfiguration('TTSLua').get('includeOtherFiles')
              //   ? this.uncompressIncludes(luaScript, '', docsFolder)
              //   : luaScript;
              obj.script = vscode.workspace.getConfiguration('TTSLua').get('includeOtherFiles')
                ? bundle.bundleString(luaScript, {
                  paths: getSearchPaths(),
                  isolate: true,
                })
                : luaScript;
            } else if (filePath.endsWith('.xml')) {
              const obj = objects.get(guid);
              // let horizontalWhitespaceSet = '\\t\\v\\f\\r \u00a0\u2000-\u200b\u2028-\u2029\u3000'
              // let insertXmlFileRegexp = RegExp('(^|\\n)([' + horizontalWhitespaceSet + ']*)(.*)<Include\\s+src=(\'|")(.+)\\4\\s*/>', 'g')
              obj.ui = fs.readFileSync(filePath, 'utf8');
            }
          }
        });
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return;
      }
      // Hackish way to detect when panel is cleared.
      this.executeWhenDone = () => {
        TTSAdapter.sendToTTS(1, { scriptStates: [...objects.values()] });
        this.savedAndPlayed = true;
        this.timeout.refresh();
      };
      if (vscode.workspace.getConfiguration('TTSLua').get('clearOnReload')) {
        this.clearPanel();
      } else {
        const f = this.executeWhenDone; f();
        this.executeWhenDone = function executeWhenDone() { };
      }
    }, (err: Error) => {
      console.error(`Unable to save all opened files: ${err.message}`);
    });
  }

  private uncompressIncludes(luaScript: string, baseFolder: string, includePath: string, alreadyInserted?: any) {
    alreadyInserted = alreadyInserted || [];
    const insertLuaFileRegexp = RegExp('^(\\s*%include\\s+([^\\s].*))', 'm');
    luaScript = luaScript.replace(/#include /g, '%include ');
    while (true) {
      const match = luaScript.match(insertLuaFileRegexp);
      if (!match) break;
      let includeFileName = match[2];
      let sharedFilePath;
      let newBaseFolder;
      const doBlock = includeFileName.startsWith('<') && includeFileName.endsWith('>');
      if (doBlock) {
        includeFileName = includeFileName.substr(1, includeFileName.length - 2);
      }
      if (includeFileName.startsWith('!')) {
        includeFileName = includeFileName.substr(1);
        sharedFilePath = includePath;
        newBaseFolder = path.dirname(includeFileName);
      } else {
        sharedFilePath = path.join(includePath, baseFolder);
        newBaseFolder = path.dirname(path.join(baseFolder, includeFileName));
      }
      const sharedFullFile = path.join(sharedFilePath, `${includeFileName}.ttslua`);
      if (!alreadyInserted.includes(sharedFullFile)) {
        alreadyInserted.push(sharedFullFile);
        let sharedFileContents;
        if (fs.existsSync(sharedFullFile) && fs.statSync(sharedFullFile).isFile()) {
          sharedFileContents = fs.readFileSync(sharedFullFile, 'utf8');
          sharedFileContents = this.uncompressIncludes(sharedFileContents, newBaseFolder, includePath, alreadyInserted);
        } else {
          throw new Error(`Include missing ${sharedFullFile} from ${includeFileName}`);
        }
        luaScript = [
          luaScript.slice(0, match.index),
          `---- #include ${match[2]}\n`,
          doBlock ? 'do\n' : '',
          sharedFileContents,
          doBlock ? '\nend\n' : '',
          `\n---- #include ${match[2]}`,
          luaScript.slice(match.index! + match[0].length),
        ].join('');
      } else {
        throw new Error(`Circular include detected at ${includeFileName}.\n The file ${sharedFullFile} has been included previously.`);
      }
    }
    return luaScript;
  }

  static customMessage(object: any) {
    TTSAdapter.sendToTTS(2, { customMessage: object });
  }

  static executeLuaCode(script: string, guid: string) {
    if (guid) TTSAdapter.sendToTTS(3, { guid, script });
    else TTSAdapter.sendToTTS(3, { guid: '-1', script });
  }

  private handleMessage(ttsMessage: TtsMessage) {
    switch (ttsMessage.messageID) {
      case this.ttsMsg.pushObject:
        TTSAdapter.readFilesFromTTS(ttsMessage.scriptStates, true);
        break;
      case this.ttsMsg.NewGame:
        if (this.savedAndPlayed) break;
        TTSAdapter.readFilesFromTTS(ttsMessage.scriptStates);
        break;
      case this.ttsMsg.Print:
        this.appendToPanel(parse(ttsMessage.message));
        break;
      case this.ttsMsg.Error:
        this.appendToPanel(ttsMessage.errorMessagePrefix, { class: 'error' });
        break;
      case this.ttsMsg.Custom: break; // Can be used instead of print for console++
      case this.ttsMsg.Return: break; // Not implemented
      case this.ttsMsg.GameSaved:
        if (vscode.workspace.getConfiguration('TTSLua').get('logSave')) {
          const today = new Date();
          this.appendToPanel(`[${today.getHours()}:${today.getMinutes()}:${today.getSeconds()}] 💾 Game Saved`);
        }
        break;
      case this.ttsMsg.ObjectCreated: break; // Not Implemented
      default: break;
    }
  }

  static readFilesFromTTS(scriptStates: ScriptState[] | undefined, previewFlag?: boolean) {
    previewFlag = previewFlag || false;

    const toOpen: FileHandler[] = [];
    const sentFromTTS: { [key: string]: boolean } = {};
    const autoOpen = vscode.workspace.getConfiguration('TTSLua').get('autoOpen');
    const createXml = vscode.workspace.getConfiguration('TTSLua').get('createXml');
    if (scriptStates) {
      scriptStates.forEach((scriptState) => {
        scriptState.name = scriptState.name.replace(/([":<>/\\|?*])/g, '');
        // XML Creation
        if (scriptState.ui || createXml) {
          const basename = `${scriptState.name}.${scriptState.guid}.xml`;
          const handler = new FileHandler(basename);
          if (scriptState.ui) {
            handler.create(scriptState.ui.trim());
          } else handler.create('');
          if (autoOpen === 'All' || previewFlag) toOpen.push(handler);
          sentFromTTS[basename] = true;
          // include system
          // let insertedXmlFileRegexp = RegExp('(<!--\\s+include\\s+([^\\s].*)\\s+-->)[\\s\\S]+?\\1', 'g')
        }
        // .ttslua Creation
        const basename = `${scriptState.name}.${scriptState.guid}.ttslua`;
        const handler = new FileHandler(basename);
        // handler.create(TTSAdapter.compressScripts(scriptState.script));
        handler.create(bundle.unbundleString(scriptState.script, { rootOnly: true }).modules[0].content);
        if (autoOpen === 'All' || autoOpen === scriptState.name || previewFlag) { toOpen.push(handler); }
        sentFromTTS[basename] = true;
      });
    }
    // Remove files not received.
    if (!previewFlag) {
      fs.readdirSync(ttsLuaDir).forEach((file) => {
        if (!(file in sentFromTTS)) {
          try { fs.unlinkSync(path.join(ttsLuaDir, file)); } catch (e) { console.error(e); }
        }
      });
    }
    const filesCount = Object.keys(sentFromTTS).length;
    const toOpenResults = [];
    for (let index = 0; index < toOpen.length; index += 1) {
      toOpenResults.push(toOpen[index].open());
    }
    Promise.all(toOpenResults).then(() => {
      vscode.window.showInformationMessage(`Received ${filesCount} files`);
    }, (err: Error) => {
      console.error(`Unable to open files: ${err.message}`);
    });
  }

  private static compressScripts(luaScript: string) {
    const storage = [];
    const insertedLuaFileRegexp = RegExp('^----(\\s*#include\\s+([^\\s].*))', 'm');
    let match = insertedLuaFileRegexp.exec(luaScript);
    while (match !== null) {
      if (storage.length === 0) storage.push(match);
      else if (storage[storage.length - 1][2] === match[2]) { // found pair
        const lastMatch = storage.pop();
        luaScript = [
          luaScript.slice(0, lastMatch!.index - 1),
          `\n#include ${match[2]}`,
          luaScript.slice(match.index + match[0].length),
        ].join('');
        match = insertedLuaFileRegexp.exec(luaScript);
        // eslint-disable-next-line no-continue
        continue;
      }
      luaScript = [
        luaScript.slice(0, match.index - 1),
        luaScript.slice(match.index + match[0].length),
      ].join('');
      match = insertedLuaFileRegexp.exec(luaScript);
    }
    return luaScript;
  }

  private static sendToTTS(messageID: number, object?: object) {
    let out = { messageID };
    if (object) out = { ...out, ...object };

    const client = net.connect(39999, 'localhost', () => {
      client.write(JSON.stringify(out));
    });
    client.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        console.error(`[TTSLua] Error: Unable to connect to TTS. Is the game open and a save loaded?\n${err}`);
      } else console.error(`[TTSLua] Client ${err}`);
    });
    client.on('end', () => client.destroy());
  }

  createOrShowPanel() {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Active
      : undefined;
    // If a panel exists, show it.
    if (this.webviewPanel) {
      this.webviewPanel.reveal(column);
      return;
    }
    // Otherwise, create it
    const panel = vscode.window.createWebviewPanel(
      'TTSConsole',
      'Tabletop Simulator Console++',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true, // Enable javascript in the webview
        localResourceRoots: [
          vscode.Uri.file(path.join(this.extensionPath, 'assets', 'webView')),
        ],
        retainContextWhenHidden: true,
      },
    );
    this.webviewPanel = this.webviewPanelInit(panel);
  }

  private webviewPanelInit(webviewPanel: vscode.WebviewPanel) {
    webviewPanel.webview.html = this.getHtmlForWebview(); // Set webview content
    webviewPanel.onDidDispose(() => this.disposePanel(), null, this.disposables);
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) webviewPanel.webview.html = this.getHtmlForWebview();
    }, null, this.disposables);
    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'command':
          TTSAdapter.customMessage({ command: message.text });
          break;
        case 'input':
          TTSAdapter.customMessage({ input: message.text });
          break;
        case 'done': {
          const f = this.executeWhenDone;
          f();
          this.executeWhenDone = function executeWhenDone() { };
          break;
        }
        default: break;
      }
    }, null, this.disposables);
    return webviewPanel;
  }

  revivePanel(webviewPanel: vscode.WebviewPanel) {
    this.webviewPanel = this.webviewPanelInit(webviewPanel);
  }

  disposePanel() {
    // Clean up our resources
    this.webviewPanel.dispose();
    this.webviewPanel = undefined;

    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  // Send a message to the webview webview.
  // Assumes panel is initialized
  appendToPanel(htmlString: string | undefined, optional?: object) {
    if (this.webviewPanel) {
      let msg = { command: 'append', htmlString };
      if (optional) msg = { ...msg, ...optional };
      this.webviewPanel.webview.postMessage(msg);
    }
  }

  clearPanel() {
    if (this.webviewPanel) {
      this.webviewPanel.webview.postMessage({ command: 'clear' });
    }
  }

  private getHtmlForWebview() {
    const scriptPathOnDisk = vscode.Uri.file(path.join(this.extensionPath, 'assets', 'webView', 'js', 'console.js'));
    const stylePathOnDisk = vscode.Uri.file(path.join(this.extensionPath, 'assets', 'webView', 'css', 'console.css'));
    const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
    const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
            :root {
              --ttslua-console-font-family: ${vscode.workspace.getConfiguration('TTSLua').get('consoleFontFamily')};
              --ttslua-console-font-size: ${vscode.workspace.getConfiguration('TTSLua').get('consoleFontSize')};
              --ttslua-console-input-height: ${vscode.workspace.getConfiguration('TTSLua').get('consoleInputHeight')};
            }
            </style>
            <link rel="stylesheet" type="text/css" href="${styleUri}">
            <!--
            Here's a content security policy that allows loading local scripts and stylesheets, and loading images over https
            This content security policy also implicitly disables inline scripts and styles. It is a best practice to extract all inline styles and scripts to external files so that they can be properly loaded without relaxing the content security policy.
            -->
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src vscode-resource: https:; style-src vscode-resource: 'unsafe-inline'; font-src https:;"/>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.4.1/jquery.min.js"></script>
            <title>Tabletop Simulator Console++</title>
        </head>
        <body>
            <div id="commandInput">
              <input type="textbox" placeholder=">command"/>
            </div>
            <div id="data"></div>
            <script id="mainScript" type="module" src="${scriptUri}" clearOnFocus="${vscode.workspace.getConfiguration('TTSLua').get('clearOnFocus')}"></script>
        </body>
        </html>`;
  }
}
