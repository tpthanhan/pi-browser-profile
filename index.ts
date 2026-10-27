/**
 * pi-browser-profile
 * -------------------
 * Drives a browser through the bundled `@playwright/cli` (the same CLI the
 * `pi-playwright` skill uses), but lets YOU pin which browser and which user
 * profile (user-data-dir) it launches with.
 *
 * Why this exists: `pi-playwright` always opens a fresh, isolated, throwaway
 * profile with bundled Chromium. It never passes `--profile` / `--persistent`,
 * so a profile you set up before (logins, cookies, extensions) is never used.
 * This extension fixes that by injecting `--browser`, `--profile`/`--persistent`
 * (and optionally a specific `--profile-directory`) on every `open`.
 *
 * It exposes:
 *   - a model-callable `browser` tool that forwards any playwright-cli
 *     subcommand (open / snapshot / click / fill / eval / close / ...), keyed
 *     to a stable session so one browser is reused across calls.
 *   - a `/browser-profile` command to view and change the configuration.
 *
 * Config lives in `config.json` next to this file and persists across sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

type BrowserName = "chromium" | "chrome" | "msedge" | "firefox" | "webkit";

interface Config {
	/** chromium | chrome | msedge | firefox | webkit */
	browser: BrowserName;
	/** user-data-dir to launch with. Empty = use a managed persistent dir. */
	profile: string;
	/** optional specific profile subfolder, e.g. "Default" or "Profile 1". */
	profileDirectory: string;
	/** keep profile on disk between runs (auto-true when `profile` is set). */
	persistent: boolean;
	/** run visibly. Usually true when you want to reuse a real profile. */
	headed: boolean;
	/** playwright-cli session name (one browser per name). */
	session: string;
	/** override path to playwright-cli.js. Empty = auto-detect. */
	playwrightCliEntry: string;
}

const DEFAULT_CONFIG: Config = {
	browser: "chrome",
	profile: "",
	profileDirectory: "",
	persistent: true,
	headed: true,
	session: "pi-profile",
	playwrightCliEntry: "",
};

function loadConfig(): Config {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cfg: Config): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Find the installed playwright-cli entry across likely install roots. */
function resolveCliEntry(cfg: Config): string {
	if (cfg.playwrightCliEntry && existsSync(cfg.playwrightCliEntry)) {
		return cfg.playwrightCliEntry;
	}
	// Try Node resolution from a few base dirs (this file, pi's global modules).
	const candidatesBases = [
		__dirname,
		join(homedir(), ".pi", "agent", "npm", "node_modules"),
	];
	for (const base of candidatesBases) {
		try {
			const req = createRequire(join(base, "index.js"));
			const manifest = req.resolve("@playwright/cli/package.json");
			const pkg = JSON.parse(readFileSync(manifest, "utf8"));
			const bin =
				typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["playwright-cli"];
			if (bin) return join(dirname(manifest), bin);
		} catch {
			/* keep trying */
		}
	}
	// Last resort: the known pi global install location.
	const known = join(
		homedir(),
		".pi",
		"agent",
		"npm",
		"node_modules",
		"@playwright",
		"cli",
		"playwright-cli.js",
	);
	if (existsSync(known)) return known;
	throw new Error(
		"Could not locate @playwright/cli. Install pi-playwright (pi install npm:pi-playwright) " +
			"or set `playwrightCliEntry` in config.json to the absolute path of playwright-cli.js.",
	);
}

/**
 * When a specific profile sub-directory is requested, Chromium needs a
 * `--profile-directory=<name>` launch arg, which the plain `--profile` flag
 * cannot express. Write a one-off playwright-cli config file carrying it.
 */
function writeProfileDirConfig(profileDirectory: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-browser-profile-"));
	const file = join(dir, "cli.config.json");
	writeFileSync(
		file,
		JSON.stringify(
			{ browser: { launchOptions: { args: [`--profile-directory=${profileDirectory}`] } } },
			null,
			2,
		),
		"utf8",
	);
	return file;
}

/** Build the full playwright-cli argv for a command. */
function buildArgs(cfg: Config, command: string, extra: string[]): string[] {
	const args: string[] = [`-s=${cfg.session}`, command];

	if (command === "open") {
		if (!extra.some((a) => a === "--browser" || a.startsWith("--browser="))) {
			args.push(`--browser=${cfg.browser}`);
		}
		const hasProfileFlag = extra.some(
			(a) => a === "--profile" || a.startsWith("--profile="),
		);
		if (!hasProfileFlag) {
			if (cfg.profile) {
				args.push(`--profile=${cfg.profile}`);
			} else if (cfg.persistent) {
				args.push("--persistent");
			}
		}
		if (cfg.headed && !extra.includes("--headed")) {
			args.push("--headed");
		}
		if (
			cfg.profileDirectory &&
			!extra.some((a) => a === "--config" || a.startsWith("--config="))
		) {
			args.push(`--config=${writeProfileDirConfig(cfg.profileDirectory)}`);
		}
	}

	return [...args, ...extra];
}

function runCli(
	entry: string,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [entry, ...args], {
			env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
			signal,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => resolve({ code: 1, stdout, stderr: stderr + String(err) }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

const MAX_OUTPUT = 20_000;
function cap(text: string): string {
	if (text.length <= MAX_OUTPUT) return text;
	return (
		text.slice(0, MAX_OUTPUT) +
		`\n\n[... output truncated at ${MAX_OUTPUT} chars. Re-run with --filename to write full output to a file ...]`
	);
}

function describe(cfg: Config): string {
	return [
		`browser:          ${cfg.browser}`,
		`profile:          ${cfg.profile || "(managed persistent dir)"}`,
		`profileDirectory: ${cfg.profileDirectory || "(default)"}`,
		`persistent:       ${cfg.persistent}`,
		`headed:           ${cfg.headed}`,
		`session:          ${cfg.session}`,
		`playwrightCli:    ${cfg.playwrightCliEntry || "(auto-detect)"}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser",
		label: "Browser (profile)",
		description:
			"Drive a browser via playwright-cli using the configured browser + user profile. " +
			"Pass a playwright-cli subcommand and its args. The session is reused across calls, " +
			"so run `open <url>` first, then `snapshot`, `click <ref>`, `fill <ref> <text>`, " +
			"`eval <js>`, `screenshot`, `close`, etc. On `open`, the configured --browser and " +
			"--profile/--persistent (and --headed) are injected automatically. " +
			"For large output (snapshot/screenshot/pdf) pass `--filename <path>` to write to a file " +
			"instead of returning it inline. Change the browser/profile with the /browser-profile command.",
		parameters: Type.Object({
			command: Type.String({
				description:
					"playwright-cli subcommand, e.g. open, snapshot, click, fill, press, select, check, eval, screenshot, pdf, console, network, close, list.",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Arguments for the subcommand, e.g. [\"https://example.com\"] or [\"e5\"] or [\"--filename\", \"C:/tmp/snap.md\"].",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const cfg = loadConfig();
			let entry: string;
			try {
				entry = resolveCliEntry(cfg);
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
					details: undefined,
				};
			}
			const extra = params.args ?? [];
			const argv = buildArgs(cfg, params.command, extra);
			const { code, stdout, stderr } = await runCli(entry, argv, signal);
			const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			const header = `$ playwright-cli ${argv.join(" ")}`;
			if (code !== 0) {
				return {
					content: [
						{ type: "text", text: `${header}\n\n[exit ${code}]\n${cap(out) || "(no output)"}` },
					],
					details: { command: params.command, args: extra, code },
				};
			}
			return {
				content: [{ type: "text", text: `${header}\n\n${cap(out) || "(ok, no output)"}` }],
				details: { command: params.command, args: extra, code },
			};
		},
	});

	pi.registerCommand("browser-profile", {
		description:
			"Show or change the browser/profile used by the `browser` tool. " +
			"Usage: /browser-profile [set <key> <value>]. Keys: browser, profile, profileDirectory, persistent, headed, session, playwrightCliEntry.",
		handler: async (argStr, ctx) => {
			const cfg = loadConfig();
			const parts = (argStr ?? "").trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0 || parts[0] === "show") {
				ctx.ui.notify(`Browser profile config:\n${describe(cfg)}`, "info");
				return;
			}

			if (parts[0] === "set" && parts.length >= 3) {
				const key = parts[1];
				const value = parts.slice(2).join(" ");
				const booleanKeys = ["persistent", "headed"];
				const stringKeys = [
					"browser",
					"profile",
					"profileDirectory",
					"session",
					"playwrightCliEntry",
				];
				if (booleanKeys.includes(key)) {
					(cfg as any)[key] = value === "true" || value === "1" || value === "yes";
				} else if (stringKeys.includes(key)) {
					(cfg as any)[key] = value;
				} else {
					ctx.ui.notify(`Unknown key "${key}".`, "error");
					return;
				}
				saveConfig(cfg);
				ctx.ui.notify(`Updated. New config:\n${describe(cfg)}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /browser-profile [show | set <key> <value>]\n" +
					"Keys: browser, profile, profileDirectory, persistent, headed, session, playwrightCliEntry",
				"info",
			);
		},
	});
}
