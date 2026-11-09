// Session persona — a selector of user-provided personas as structured markdown files.
//
// Every persona is one `.md` file with optional frontmatter (`name`, `title`) and a markdown body.
// The package ships no personas: it discovers them from the project (`.pi/personas/`) and from the
// user config directory (`$PI_CODING_AGENT_DIR/personas/`, default `~/.pi/agent/personas/`), and the
// chosen body is appended to the base prompt, so a persona inherits the neutral persona and every
// harness rule already in the prompt. The choice is persisted as a custom session entry, and the
// persona name becomes the session display name.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const PERSONA_ENTRY = "pi-session-personas-gs.persona"
export const PERSONA_COMMAND = "gentle:sesion-persona"
export const CLEAR_ALIASES = ["none", "neutral", "ninguna"] as const
export const TEMPLATE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"assets",
	"persona-template.md",
)

export interface Persona {
	/** File stem, lowercased: how the command and the session entry identify it. */
	id: string
	/** Display name, from frontmatter `name` or the file stem. */
	name: string
	/** Optional role line, from frontmatter `title`. */
	title?: string
	/** The markdown body appended to the prompt. */
	body: string
	/** Absolute path of the file, for reporting and diagnostics. */
	path: string
}

/** Parse `key: value` frontmatter and the body of one persona file. */
export function parsePersonaFile(path: string): Persona | undefined {
	let text: string
	try {
		text = readFileSync(path, "utf8")
	} catch {
		return undefined
	}
	const id = basename(path, ".md").toLowerCase()
	let body = text.trim()
	let name = basename(path, ".md")
	let title: string | undefined

	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
	if (frontmatter !== null) {
		body = text.slice(frontmatter[0].length).trim()
		for (const line of frontmatter[1]!.split(/\r?\n/)) {
			const match = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
			if (match === null) continue
			const key = match[1]!.toLowerCase()
			const value = match[2]!.trim().replace(/^["']|["']$/g, "")
			if (key === "name" && value.length > 0) name = value
			if (key === "title" && value.length > 0) title = value
		}
	}

	if (body.length === 0) return undefined
	return title === undefined ? { id, name, body, path } : { id, name, title, body, path }
}

/**
 * Agent home, resolved the way Gentle Shell resolves it: `GENTLE_PI_AGENT_HOME`, then
 * `PI_CODING_AGENT_DIR`, then the Gentle Shell prefix (`~/.gentle-shell/agent`), then `~/.pi/agent`.
 */
export function agentHome(env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): string {
	if (env.GENTLE_PI_AGENT_HOME !== undefined && env.GENTLE_PI_AGENT_HOME.length > 0) return env.GENTLE_PI_AGENT_HOME
	if (env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR.length > 0) return env.PI_CODING_AGENT_DIR
	const gentleShellHome = join(home, ".gentle-shell", "agent")
	return existsSync(gentleShellHome) ? gentleShellHome : join(home, ".pi", "agent")
}

/** Project personas first, then user personas: the project overrides a user persona with the same id. */
export function personaRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	return [join(cwd, ".pi", "personas"), join(agentHome(env), "personas")]
}

/** Every persona found under the given roots, project first, then alphabetical by name. */
export function discoverPersonas(roots: readonly string[]): Persona[] {
	const found = new Map<string, Persona>()
	for (const root of roots) {
		let files: string[]
		try {
			files = readdirSync(root).filter((file) => file.toLowerCase().endsWith(".md")).sort()
		} catch {
			continue
		}
		for (const file of files) {
			const persona = parsePersonaFile(join(root, file))
			if (persona === undefined || found.has(persona.id)) continue
			found.set(persona.id, persona)
		}
	}
	return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Resolve a command argument: a persona id, `null` to clear, or `undefined` when unknown. */
export function resolvePersonaArgument(
	argument: string,
	personas: readonly Persona[],
): string | null | undefined {
	const requested = argument.trim().toLowerCase()
	if (requested.length === 0) return undefined
	if ((CLEAR_ALIASES as readonly string[]).includes(requested)) return null
	const byId = personas.find((persona) => persona.id === requested)
	if (byId !== undefined) return byId.id
	const byName = personas.find((persona) => persona.name.toLowerCase() === requested)
	return byName?.id
}

/** Append a persona body to the base prompt, keeping the base (neutral) prompt byte for byte. */
export function appendPersona(basePrompt: string, persona: Persona): string {
	const heading = persona.title === undefined ? `## Session persona: ${persona.name}` : `## Session persona: ${persona.name}, ${persona.title}`
	return `${basePrompt.trimEnd()}\n\n${heading}\n\n${persona.body.trim()}\n`
}

/** Last persisted persona entry wins, so a session resumes with the persona it was switched to. */
export function restorePersonaId(entries: readonly unknown[]): string | undefined {
	let restored: string | undefined
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown }
		if (candidate.type !== "custom" || candidate.customType !== PERSONA_ENTRY) continue
		const data = candidate.data as { id?: unknown } | undefined
		if (typeof data?.id === "string" && data.id.length > 0) restored = data.id
	}
	return restored
}

export default function sessionPersona(
	pi: ExtensionAPI,
	child = process.env.GENTLE_PI_AGENTS_CHILD === "1",
) {
	let activePersona: string | undefined

	pi.on("session_start", async (_event, ctx) => {
		if (child) return
		activePersona = restorePersonaId(ctx.sessionManager.getEntries())
	})

	pi.on("before_agent_start", async (event, ctx) => {
		if (child || activePersona === undefined) return
		const persona = discoverPersonas(personaRoots(ctx.cwd)).find((candidate) => candidate.id === activePersona)
		if (persona === undefined) return
		return { systemPrompt: appendPersona(event.systemPrompt ?? "", persona) }
	})

	pi.registerCommand(PERSONA_COMMAND, {
		description: "Choose this session's persona from the markdown files in .pi/personas/ or the user personas directory.",
		handler: async (args: string, ctx) => {
			const notify = (message: string, level: "info" | "warning" | "error" = "info") =>
				ctx.ui.notify(message, level)
			const roots = personaRoots(ctx.cwd)
			const personas = discoverPersonas(roots)
			const requested = (args ?? "").trim()

			if (requested.length === 0 && personas.length === 0) {
				notify(
					`No persona files found. Add one .md file to ${roots[0]} or ${roots[1]}; the template is ${TEMPLATE_PATH}.`,
					"warning",
				)
				return
			}

			let target: string | null | undefined
			if (requested.length > 0) {
				target = resolvePersonaArgument(requested, personas)
				if (target === undefined) {
					notify(
						`Unknown persona: ${requested}. Available: ${personas.map((persona) => persona.id).join(", ") || "none"}; or none.`,
						"warning",
					)
					return
				}
			} else {
				const labels = personas.map((persona) =>
					persona.title === undefined ? persona.name : `${persona.name} - ${persona.title}`,
				)
				const selected = await ctx.ui.select("Session persona", [...labels, "None"])
				if (selected === undefined || selected === "None") {
					if (selected === undefined) return
					target = null
				} else {
					const index = labels.indexOf(selected)
					target = index >= 0 ? personas[index]!.id : undefined
				}
				if (target === undefined) return
			}

			if (target === null) {
				activePersona = undefined
				pi.appendEntry(PERSONA_ENTRY, { id: null })
				notify("Session persona cleared: the neutral persona applies from the next turn. Session name unchanged.")
				return
			}

			const persona = personas.find((candidate) => candidate.id === target)
			if (persona === undefined) return
			activePersona = persona.id
			pi.appendEntry(PERSONA_ENTRY, { id: persona.id })
			pi.setSessionName(persona.name)
			notify(
				`Session persona: ${persona.name}${persona.title === undefined ? "" : ` (${persona.title})`} from ${persona.path}. It applies from the next turn; session name set to ${persona.name}.`,
			)
		},
	})
}

/** Guard against a template file that disappeared from an installed package. */
export function templateExists(): boolean {
	return existsSync(TEMPLATE_PATH)
}
