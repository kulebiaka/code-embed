// Test double for the "vscode" module (aliased in vitest.config.ts). Functions throw until mocked
// with vi.spyOn / vi.mock so that unexpected calls fail loudly.

function unmocked(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`vscode-stub: ${name} is not mocked`);
  };
}

export class Disposable {
  constructor(private readonly callOnDispose: () => unknown) {}
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
  dispose(): void {
    this.callOnDispose();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>();

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.listeners.add(bound);
    const d = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(d);
    return d;
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  static file(fsPath: string): Uri {
    return new Uri("file", "", fsPath.replace(/\\/g, "/"), "", "");
  }

  static parse(value: string): Uri {
    const u = new URL(value);
    return new Uri(u.protocol.replace(/:$/, ""), u.host, decodeURIComponent(u.pathname), u.search.replace(/^\?/, ""), u.hash.replace(/^#/, ""));
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const path = [base.path.replace(/\/+$/, ""), ...segments].join("/");
    return new Uri(base.scheme, base.authority, path, base.query, base.fragment);
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === "number" && typeof b === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}

export class McpStdioServerDefinition {
  constructor(
    readonly label: string,
    readonly command: string,
    readonly args: string[] = [],
    readonly env: Record<string, string | number | null> = {},
    readonly version?: string,
  ) {}
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(readonly content: unknown[]) {}
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  private cancelled = false;
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const window = {
  activeTextEditor: undefined as unknown,
  createOutputChannel: unmocked("window.createOutputChannel"),
  createStatusBarItem: unmocked("window.createStatusBarItem"),
  registerWebviewViewProvider: unmocked("window.registerWebviewViewProvider"),
  createWebviewPanel: unmocked("window.createWebviewPanel"),
  showOpenDialog: unmocked("window.showOpenDialog"),
  showInformationMessage: unmocked("window.showInformationMessage"),
  showWarningMessage: unmocked("window.showWarningMessage"),
  showErrorMessage: unmocked("window.showErrorMessage"),
  showQuickPick: unmocked("window.showQuickPick"),
  showInputBox: unmocked("window.showInputBox"),
  createQuickPick: unmocked("window.createQuickPick"),
  showTextDocument: unmocked("window.showTextDocument"),
  setStatusBarMessage: unmocked("window.setStatusBarMessage"),
  withProgress: unmocked("window.withProgress"),
  onDidChangeActiveTextEditor: unmocked("window.onDidChangeActiveTextEditor"),
};

export const workspace = {
  workspaceFolders: undefined as unknown,
  getConfiguration: unmocked("workspace.getConfiguration"),
  onDidChangeConfiguration: unmocked("workspace.onDidChangeConfiguration"),
  onDidOpenTextDocument: unmocked("workspace.onDidOpenTextDocument"),
  createFileSystemWatcher: unmocked("workspace.createFileSystemWatcher"),
  openTextDocument: unmocked("workspace.openTextDocument"),
  asRelativePath: unmocked("workspace.asRelativePath"),
  getWorkspaceFolder: unmocked("workspace.getWorkspaceFolder"),
};

export const commands = {
  registerCommand: unmocked("commands.registerCommand"),
  executeCommand: unmocked("commands.executeCommand"),
};

export const env = {
  appName: "Visual Studio Code",
  uriScheme: "vscode",
  clipboard: { writeText: unmocked("env.clipboard.writeText"), readText: unmocked("env.clipboard.readText") },
  openExternal: unmocked("env.openExternal"),
};

export const lm = {
  registerTool: unmocked("lm.registerTool"),
  registerMcpServerDefinitionProvider: unmocked("lm.registerMcpServerDefinitionProvider"),
};
