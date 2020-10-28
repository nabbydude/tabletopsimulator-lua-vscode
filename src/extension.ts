// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import activateCompletion from './language/completion';
// import { tryCreateWorkspaceFolder, tryInstallConsole } from './filehandler';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  /* ----------------------------- Initialization ----------------------------- */
  // tryCreateWorkspaceFolder();
  activateCompletion(context);
  // let adapter = new TTSAdapter(context.extensionPath);
  console.debug('[TTSLua] Tabletop Simulator Extension Loaded');
}

// this method is called when your extension is deactivated
export function deactivate() { console.debug('Tabletop Simulator Extension Unloaded'); }
