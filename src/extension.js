const vscode = require("vscode");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

let nodeSqlite;
try {
	nodeSqlite = require("node:sqlite");
} catch {
	nodeSqlite = undefined;
}

const STORAGE_KEY =
	"src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const STATE_DB_FILE = "state.vscdb";
const LABEL = "OpenAI Key";
const TOGGLE_COMMAND = "aiSettings.usingOpenAIKey.toggle";
// Cursor flushes state.vscdb after the toggle command returns.
// Read at 300, 600 and 900ms, and stop once the value flips.
const KEY_REFRESH_DELAYS_MS = [300, 600, 900];

const QUERY = `SELECT value FROM ItemTable WHERE key = '${STORAGE_KEY}';`;

let statusBarItem;
let pollTimer;
let debounceTimer;
let burstTimers = [];
let burstGeneration = 0;
let lastState; // true | false | undefined
let log;

function parseState(raw) {
	if (!raw) return undefined;
	const parsed = JSON.parse(raw);
	return parsed.useOpenAIKey === true;
}

// Strategy 1: node:sqlite (Electron/Node >= 22.5). Does not load the DB into memory.
function readViaNodeSqlite(dbPath) {
	const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db.prepare(QUERY).get();
		return parseState(row && row.value);
	} finally {
		db.close();
	}
}

// Strategy 2: sqlite3 CLI, if present on PATH.
async function readViaSqlite3Cli(dbPath) {
	const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, QUERY]);
	return parseState(stdout.trim());
}

// Strategy 3: python stdlib sqlite3.
async function readViaPython(dbPath) {
	const script = [
		"import sqlite3,sys",
		"c=sqlite3.connect('file:'+sys.argv[1].replace(chr(92),'/')+'?mode=ro',uri=True)",
		`r=c.execute(${JSON.stringify(QUERY)}).fetchone()`,
		"sys.stdout.write(r[0] if r else '')",
	].join("\n");
	for (const exe of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
		try {
			const { stdout } = await execFileAsync(exe, ["-c", script, dbPath], { maxBuffer: 64 * 1024 * 1024 });
			return parseState(stdout.trim());
		} catch {
			// try next
		}
	}
	throw new Error("python not available");
}

async function readUseOpenAIKey(dbPath) {
	const strategies = [];
	if (nodeSqlite) strategies.push(["node:sqlite", () => readViaNodeSqlite(dbPath)]);
	strategies.push(["sqlite3", () => readViaSqlite3Cli(dbPath)]);
	strategies.push(["python", () => readViaPython(dbPath)]);
	for (const [name, fn] of strategies) {
		try {
			return await fn();
		} catch (err) {
			log?.appendLine(`[read] ${name} failed: ${err && err.message ? err.message : err}`);
		}
	}
	return undefined;
}

function render(state) {
	if (!statusBarItem) return;
	if (state === true) {
		statusBarItem.text = `$(key) ${LABEL}: ON`;
		statusBarItem.tooltip = "OpenAI API Key toggle is ON";
		statusBarItem.backgroundColor = undefined;
		statusBarItem.color = undefined;
	} else if (state === false) {
		statusBarItem.text = `$(key) ${LABEL}: OFF`;
		statusBarItem.tooltip = "OpenAI API Key toggle is OFF";
		statusBarItem.backgroundColor = new vscode.ThemeColor(
			"statusBarItem.warningBackground",
		);
		statusBarItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
	} else {
		statusBarItem.text = `$(key) ${LABEL}: ?`;
		statusBarItem.tooltip = "Could not read OpenAI API Key toggle state";
		statusBarItem.backgroundColor = undefined;
		statusBarItem.color = undefined;
	}
	statusBarItem.show();
}

async function activate(context) {
	log = vscode.window.createOutputChannel("OpenAI Key Indicator");
	context.subscriptions.push(log);
	log.appendLine(`[activate] node:sqlite=${!!nodeSqlite} node=${process.versions.node}`);

	const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
	const dbPath = path.join(globalStorageDir, STATE_DB_FILE);

	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarItem.name = "OpenAI Key Indicator";
	statusBarItem.command = "openai-key-indicator.refresh";
	context.subscriptions.push(statusBarItem);

	let refreshQueue = Promise.resolve();
	const refresh = () => {
		const run = refreshQueue.then(async () => {
			const state = await readUseOpenAIKey(dbPath);
			if (state !== lastState) {
				lastState = state;
				render(state);
			}
		});
		refreshQueue = run.catch((err) => {
			log.appendLine(`[refresh] ${err && err.message ? err.message : err}`);
		});
		return run;
	};

	const scheduleRefreshBurst = () => {
		burstGeneration++;
		for (const timer of burstTimers) clearTimeout(timer);
		burstTimers = [];
		const generation = burstGeneration;
		const started = lastState;
		for (const delay of KEY_REFRESH_DELAYS_MS) {
			const timer = setTimeout(() => {
				void refresh().then(
					() => {
						if (generation !== burstGeneration) return;
						if (typeof lastState === "boolean" && lastState !== started) {
							burstGeneration++;
							for (const pending of burstTimers) clearTimeout(pending);
							burstTimers = [];
						}
					},
					() => {},
				);
			}, delay);
			burstTimers.push(timer);
		}
	};

	const toggleAndRefresh = async () => {
		try {
			await vscode.commands.executeCommand(TOGGLE_COMMAND);
		} catch (err) {
			log.appendLine(`[toggle] ${err && err.message ? err.message : err}`);
		}
		scheduleRefreshBurst();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("openai-key-indicator.refresh", refresh),
		vscode.commands.registerCommand(
			"openai-key-indicator.toggleAndRefresh",
			toggleAndRefresh,
		),
	);

	// File watcher on state.vscdb (+ -wal), debounced.
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(
			vscode.Uri.file(globalStorageDir),
			`${STATE_DB_FILE}*`,
		),
	);
	const onChange = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void refresh(), 500);
	};
	context.subscriptions.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));

	// Polling fallback.
	const startPolling = () => {
		if (pollTimer) clearInterval(pollTimer);
		const interval = Math.max(
			500,
			vscode.workspace
				.getConfiguration("openaiKeyIndicator")
				.get("pollIntervalMs", 30000),
		);
		pollTimer = setInterval(() => void refresh(), interval);
	};
	startPolling();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("openaiKeyIndicator")) startPolling();
		}),
		{ dispose: () => pollTimer && clearInterval(pollTimer) },
	);

	render(undefined);
	await refresh();
}

function deactivate() {
	if (pollTimer) clearInterval(pollTimer);
	if (debounceTimer) clearTimeout(debounceTimer);
	burstGeneration++;
	for (const timer of burstTimers) clearTimeout(timer);
	burstTimers = [];
}

module.exports = { activate, deactivate };
