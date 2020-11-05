/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-param-reassign */
import * as net from 'net';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
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
  const bundleSearchPattern = vscode.workspace.getConfiguration('TTSLua').get('bundleSearchPattern') as string;
  bundleSearchPattern.split(';').map((pattern) => [
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

  private webviewPanel: vscode.WebviewPanel | null = null;

  private progressBars: {
    [key: string]: {
      resolve: (value?: unknown) => void,
      token?: vscode.CancellationToken,
      progress: vscode.Progress<{
        message?: string | undefined;
        increment?: number | undefined;
      }>
    }
  } = {};

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
          this.server.listen(39998, 'localhost');
        }, 1000);
      } else console.error(`[TTSLua] Error: ${err}`);
    });
    this.server.listen(39998, 'localhost'); // Open Server
  }

  getScripts() {
    const vsFolders = vscode.workspace.workspaceFolders;
    if (!vsFolders || vsFolders.findIndex((val) => val.uri.fsPath === this.dir.fsPath) === -1) {
      vscode.workspace.updateWorkspaceFolders(vsFolders ? vsFolders.length : 0, null, { uri: this.dir });
    }
    this.updateProgress('Receiving scripts', { increment: 0, message: 'Connecting to TTS' });
    TTSAdapter.sendToTTS(0);
  }

  saveAndPlay() {
    const vsFolders = vscode.workspace.workspaceFolders;
    if (!vsFolders || vsFolders.findIndex((val) => val.uri.fsPath === this.dir.fsPath) === -1) {
      vscode.window.showErrorMessage('The workspace is not opened on the Tabletop Simulator folder.\nGet Lua Scripts from game before trying to Save and Play.');
      return;
    }
    this.updateProgress('Sending scripts', { increment: 10 });
    vscode.workspace.saveAll(false).then(async () => {
      const objects = new Map();
      try {
        const files = fs.readdirSync(ttsLuaDir);
        const totalFiles = Object.keys(files).length;
        let currentFile = 1;
        files.forEach((file) => {
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
            if (filePath.endsWith('.lua')) {
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
          // eslint-disable-next-line no-plusplus
          this.updateProgress('Sending scripts', { increment: 90 / totalFiles, message: `${currentFile++}/${totalFiles}` });
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
      this.updateProgress('Sending scripts', { increment: 0, message: 'Done!' });
      setTimeout(() => {
        this.finishProgres('Sending scripts');
      }, 3000);
    }, (err: Error) => {
      console.error(`Unable to save all opened files: ${err.message}`);
    });
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
        this.updateProgress('Receiving scripts', { increment: 0 });
        this.readFilesFromTTS(ttsMessage.scriptStates, true);
        break;
      case this.ttsMsg.NewGame:
        if (this.savedAndPlayed) break;
        this.updateProgress('Receiving scripts', { increment: 0 });
        this.readFilesFromTTS(ttsMessage.scriptStates);
        break;
      case this.ttsMsg.Print:
        this.appendToPanel(parse(ttsMessage.message!));
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

  private readFilesFromTTS(scriptStates: ScriptState[] | undefined, previewFlag?: boolean) {
    previewFlag = previewFlag || false;
    const toOpen: FileHandler[] = [];
    const sentFromTTS: { [key: string]: boolean } = {};
    const autoOpen = vscode.workspace.getConfiguration('TTSLua').get('autoOpen');
    const createXml = vscode.workspace.getConfiguration('TTSLua').get('createXml');
    console.dir(scriptStates);
    if (scriptStates) {
      // const increment = 45 / Object.keys(scriptStates).length;
      scriptStates.forEach((scriptState) => {
        // this.updateProgress('Receiving scripts', { increment });
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
        // this.updateProgress('Receiving scripts', { increment });
        // .lua Creation
        const basename = `${scriptState.name}.${scriptState.guid}.lua`;
        const handler = new FileHandler(basename);
        let fileContent = scriptState.script;
        try {
          // eslint-disable-next-line no-underscore-dangle
          const { content } = bundle.unbundleString(scriptState.script).modules.__root;
          if (content !== '') { fileContent = content; }
          // eslint-disable-next-line no-empty
        } catch (err: any) { }
        handler.create(fileContent);
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
      // vscode.window.showInformationMessage(`Received ${filesCount} files`);
      this.updateProgress('Receiving scripts', { increment: 100, message: `Received ${filesCount} files!` });
      setTimeout(() => {
        this.finishProgres('Receiving scripts');
      }, 3000);
    }, (err: Error) => {
      console.error(`Unable to open files: ${err.message}`);
    });
  }

  private static sendToTTS(messageID: number, object?: object) {
    let out = { messageID };
    if (object) out = { ...out, ...object };

    const client = net.connect(39999, 'localhost', () => {
      client.write(JSON.stringify(out));
    });
    client.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        vscode.window.showErrorMessage('ERROR: Unable to connect to Tabletop Simulator.\n\n'
          + 'Check that the game is running and a save has been loaded.\n'
          + 'If the problem persists, try using the "Save & Play" button in the in-game Modding tab.', { modal: true });
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
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview); // Set webview content
    webviewPanel.onDidDispose(() => this.disposePanel(), null, this.disposables);
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
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
    if (this.webviewPanel) {
      this.webviewPanel.dispose();
      this.webviewPanel = null;
    }

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

  private getHtmlForWebview(webview: vscode.Webview) {
    const scriptPathOnDisk = vscode.Uri.file(path.join(this.extensionPath, 'assets', 'webView', 'js', 'console.js'));
    const stylePathOnDisk = vscode.Uri.file(path.join(this.extensionPath, 'assets', 'webView', 'css', 'console.css'));
    const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
    const styleUri = stylePathOnDisk.with({ scheme: 'vscode-resource' });
    const { cspSource } = webview;
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
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; script-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; font-src https:;"/>
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

  private updateProgress(title: string, options: { increment: number, message?: string }) {
    if (!(title in this.progressBars)) {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title,
        cancellable: false,
      }, (progress) => new Promise((resolve) => { this.progressBars[title] = { resolve, progress }; }));
    }
    this.progressBars[title].progress.report(options);
  }

  private finishProgres(title: string) {
    if (!(title in this.progressBars)) throw new Error(`[TTSLua] Attempted to finish a non-existant progressbar "${title}"`);
    this.progressBars[title].resolve();
    delete this.progressBars[title];
  }
}
