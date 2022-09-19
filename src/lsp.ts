import * as fs from "fs";
import * as path from "path";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
} from "vscode-languageclient/node";

import * as which from "which";

import * as vscode from "vscode";

import {
  SEMGREP_BINARY,
  CLIENT_ID,
  CLIENT_NAME,
  DIAGNOSTIC_COLLECTION_NAME,
} from "./constants";
import { Environment } from "./env";
import { activate } from "./extension";

async function findSemgrep(env: Environment): Promise<string | null> {
  if (env.config.path !== "semgrep") {
    return env.config.path;
  }
  const server = which.sync(SEMGREP_BINARY, { nothrow: true });
  if (!server) {
    const brew = which.sync("brew", { nothrow: true });
    const pip = which.sync("pip", { nothrow: true });
    const pip3 = which.sync("pip3", { nothrow: true });
    const pip_install = "Install with pip (Preferred)";
    const brew_install = "Install with brew";
    const resp = await vscode.window.showInformationMessage(
      "Semgrep is not installed! Please install to use this extension",
      pip_install,
      brew_install
    );
    let command = null;
    switch (resp) {
      case pip_install:
        command = pip3 ? pip3 : pip;
        break;
      case brew_install:
        command = brew;
        break;
    }
    if (command) {
      const terminal = vscode.window.createTerminal(`Ext Terminal #1`);
      terminal.sendText(command + " install semgrep && exit");
      vscode.window.onDidCloseTerminal((t) => {
        if (t == terminal) {
          vscode.window.showInformationMessage("Semgrep succesfully installed");
          if (resp == brew_install) {
            vscode.window.showInformationMessage(
              "Please run *sudo launchctl config user path '$(brew --prefix)/bin:${PATH}'* and restart to enable Semgrep. See [https://docs.brew.sh/FAQ#my-mac-apps-dont-find-homebrew-utilities]"
            );
          }
          activate(env.context);
        }
      });
    } else if (resp) {
      vscode.window.showErrorMessage(
        "Error: chosen package manager not installed"
      );
    }
    return null;
  }
  return server;
}

function semgrepCmdLineOpts(env: Environment): string[] {
  const cmdlineOpts = [];

  // Subcommand
  cmdlineOpts.push(...["lsp"]);

  if (env.config.config_path.length > 0) {
    cmdlineOpts.push(...[env.config.config_path]);
  }

  // Logging
  if (env.config.logging) {
    cmdlineOpts.push(...["--debug"]);
  }

  return cmdlineOpts;
}

async function lspOptions(
  env: Environment
): Promise<[ServerOptions, LanguageClientOptions] | [null, null]> {
  const server = await findSemgrep(env);
  if (!server) {
    return [null, null];
  }

  env.logger.log(`Found server binary at: ${server}`);
  let cwd = path.dirname(fs.realpathSync(server));
  if (vscode.workspace.workspaceFolders !== undefined) {
    cwd = vscode.workspace.workspaceFolders[0].uri.path;
  }
  env.logger.log(`  ... cwd := ${cwd}`);
  const cmdlineOpts = semgrepCmdLineOpts(env);
  const run: Executable = {
    command: server,
    args: cmdlineOpts,
    options: { cwd: cwd },
  };

  const serverOptions: ServerOptions = {
    run,
    debug: run,
  };
  env.logger.log(`Semgrep LSP server configuration := ${JSON.stringify(run)}`);
  const clientOptions: LanguageClientOptions = {
    diagnosticCollectionName: DIAGNOSTIC_COLLECTION_NAME,
    // TODO: should we limit to support languages and keep the list manually updated?
    documentSelector: [{ language: "*", scheme: "file" }],
    outputChannel: env.channel,
    initializationOptions: env.config.cfg,
  };

  return [serverOptions, clientOptions];
}

async function start(env: Environment): Promise<LanguageClient | null> {
  // Compute LSP server and client options
  const [serverOptions, clientOptions] = await lspOptions(env);

  // If we cannot find Semgrep, there's no point
  // in proceeding with the activation.
  if (!serverOptions) return null;

  // Create the language client.
  const c = new LanguageClient(
    CLIENT_ID,
    CLIENT_NAME,
    serverOptions,
    clientOptions
  );

  // register commands
  // Start the client. This will also launch the server
  env.logger.log("Starting language client...");
  await c.start();
  return c;
}

async function stop(
  env: Environment | null,
  client: LanguageClient
): Promise<void> {
  env?.logger.log("Stopping language client...");
  await client.sendRequest("shutdown").then(async () => {
    env?.logger.log("Exiting");
    await client.sendRequest("exit");
  });
  await client.stop();
  env?.logger.log("Language client stopped...");
}

export async function activateLsp(
  env: Environment
): Promise<LanguageClient | null> {
  return start(env);
}

export async function deactivateLsp(
  env: Environment | null,
  client: LanguageClient
): Promise<void> {
  await stop(env, client);
}

export async function restartLsp(
  env: Environment | null,
  client: LanguageClient
): Promise<LanguageClient | null> {
  await stop(env, client);
  if (env) {
    return start(env);
  }
  return null;
}
