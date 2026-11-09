import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sessionPersona, {
	PERSONA_COMMAND,
	PERSONA_ENTRY,
	TEMPLATE_PATH,
	agentHome,
	appendPersona,
	discoverPersonas,
	parsePersonaFile,
	personaRoots,
	resolvePersonaArgument,
	restorePersonaId,
	templateExists,
} from "../extensions/session-persona.ts"

type Handler = (event: unknown, ctx: unknown) => unknown

const BASE_PROMPT = "Neutral persona: keep replies concrete.\n\nHarness rules: follow the ceremony."

const PERSONA_FILE = (name: string, title: string, body: string) =>
	`---\nname: ${name}\ntitle: ${title}\n---\n\n${body}\n`

interface Workspace {
	cwd: string
	agentDir: string
	write: (relative: string, content: string) => string
	cleanup: () => void
}

function makeWorkspace(projectFiles: Record<string, string> = {}, userFiles: Record<string, string> = {}): Workspace {
	const root = mkdtempSync(join(tmpdir(), "session-persona-"))
	const cwd = join(root, "project")
	const agentDir = join(root, "agent")
	mkdirSync(cwd, { recursive: true })
	mkdirSync(agentDir, { recursive: true })
	const write = (relative: string, content: string) => {
		const path = join(cwd, relative)
		mkdirSync(join(path, ".."), { recursive: true })
		writeFileSync(path, content)
		return path
	}
	for (const [name, content] of Object.entries(projectFiles)) write(join(".pi", "personas", name), content)
	for (const [name, content] of Object.entries(userFiles)) {
		mkdirSync(join(agentDir, "personas"), { recursive: true })
		writeFileSync(join(agentDir, "personas", name), content)
	}
	return {
		cwd,
		agentDir,
		write,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

function setup(
	workspace: Workspace,
	options: { child?: boolean; entries?: unknown[]; selection?: string } = {},
) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR
	process.env.PI_CODING_AGENT_DIR = workspace.agentDir
	const handlers: Record<string, Handler> = {}
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {}
	const entries: Array<{ customType: string; data: unknown }> = []
	const names: string[] = []
	const notices: Array<{ message: string; level: string }> = []
	const selections: string[][] = []
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers[name] = handler
		},
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = definition
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		setSessionName: (name: string) => names.push(name),
	}
	const ctx = {
		cwd: workspace.cwd,
		sessionManager: { getEntries: () => options.entries ?? [] },
		ui: {
			notify: (message: string, level = "info") => notices.push({ message, level }),
			select: async (_title: string, labels: string[]) => {
				selections.push(labels)
				return options.selection
			},
		},
	}
	sessionPersona(pi as never, options.child ?? false)
	return {
		entries,
		names,
		notices,
		selections,
		restoreEnv: () => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir
		},
		start: () => handlers.session_start?.({ reason: "startup" }, ctx) as Promise<unknown>,
		beforeAgentStart: () =>
			handlers.before_agent_start?.({ systemPrompt: BASE_PROMPT }, ctx) as Promise<
				{ systemPrompt: string } | undefined
			>,
		run: (args: string) => commands[PERSONA_COMMAND]!.handler(args, ctx),
	}
}

test("parses frontmatter name and title, and the body without it", () => {
	const workspace = makeWorkspace()
	try {
		const path = workspace.write(join(".pi", "personas", "ada.md"), PERSONA_FILE("Ada", "senior backend engineer", "## Role\n\nYou are Ada."))
		const persona = parsePersonaFile(path)
		assert.equal(persona?.id, "ada")
		assert.equal(persona?.name, "Ada")
		assert.equal(persona?.title, "senior backend engineer")
		assert.equal(persona?.body, "## Role\n\nYou are Ada.")
	} finally {
		workspace.cleanup()
	}
})

test("a persona without frontmatter takes the file stem as its name", () => {
	const workspace = makeWorkspace()
	try {
		const path = workspace.write(join(".pi", "personas", "sam.md"), "## Role\n\nYou are Sam.")
		const persona = parsePersonaFile(path)
		assert.equal(persona?.name, "sam")
		assert.equal(persona?.title, undefined)
		assert.equal(persona?.body, "## Role\n\nYou are Sam.")
	} finally {
		workspace.cleanup()
	}
})

test("a persona with an empty body is ignored", () => {
	const workspace = makeWorkspace()
	try {
		const path = workspace.write(join(".pi", "personas", "empty.md"), "---\nname: Empty\n---\n\n   \n")
		assert.equal(parsePersonaFile(path), undefined)
	} finally {
		workspace.cleanup()
	}
})

test("project personas win over user personas with the same id, and the rest come sorted", () => {
	const workspace = makeWorkspace(
		{ "ada.md": PERSONA_FILE("Ada Project", "frontend", "project body"), "bob.md": PERSONA_FILE("Bob", "devops", "bob body") },
		{ "ada.md": PERSONA_FILE("Ada User", "backend", "user body"), "zoe.md": PERSONA_FILE("Zoe", "qa", "zoe body") },
	)
	try {
		const personas = discoverPersonas(personaRoots(workspace.cwd, { PI_CODING_AGENT_DIR: workspace.agentDir }))
		assert.deepEqual(
			personas.map((persona) => `${persona.id}:${persona.name}`),
			["ada:Ada Project", "bob:Bob", "zoe:Zoe"],
		)
	} finally {
		workspace.cleanup()
	}
})

test("discovery skips missing directories and non-markdown files", () => {
	const workspace = makeWorkspace({ "notes.txt": "ignore me" })
	try {
		assert.deepEqual(discoverPersonas([join(workspace.cwd, "nowhere")]), [])
		assert.deepEqual(discoverPersonas(personaRoots(workspace.cwd, { PI_CODING_AGENT_DIR: workspace.agentDir })), [])
	} finally {
		workspace.cleanup()
	}
})

test("the agent home follows Gentle Shell, then Pi, then the prefix, then ~/.pi/agent", () => {
	assert.equal(agentHome({ GENTLE_PI_AGENT_HOME: "/gs/agent", PI_CODING_AGENT_DIR: "/pi/agent", HOME: "/home/x" }), "/gs/agent")
	assert.equal(agentHome({ PI_CODING_AGENT_DIR: "/pi/agent", HOME: "/home/x" }), "/pi/agent")
	assert.equal(agentHome({ HOME: "/home/x" }), join("/home/x", ".pi", "agent"))
})

test("persona roots put the project first and resolve the Gentle Shell prefix when it exists", () => {
	const home = mkdtempSync(join(tmpdir(), "persona-home-"))
	try {
		assert.deepEqual(personaRoots("/work/repo", { HOME: home }), ["/work/repo/.pi/personas", join(home, ".pi", "agent", "personas")])
		mkdirSync(join(home, ".gentle-shell", "agent"), { recursive: true })
		assert.deepEqual(personaRoots("/work/repo", { HOME: home }), [
			"/work/repo/.pi/personas",
			join(home, ".gentle-shell", "agent", "personas"),
		])
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})

test("selecting a persona persists it and takes the persona name as the session name", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "senior backend engineer", "## Role\n\nYou are Ada.") })
	const harness = setup(workspace)
	try {
		await harness.run("ada")
		assert.deepEqual(harness.entries, [{ customType: PERSONA_ENTRY, data: { id: "ada" } }])
		assert.deepEqual(harness.names, ["Ada"])
		assert.match(harness.notices.at(-1)!.message, /Session persona: Ada \(senior backend engineer\) from .*ada\.md/)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("the persona body is appended under a heading and the neutral base prompt stays intact", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "senior backend engineer", "## Role\n\nYou are Ada.") })
	const harness = setup(workspace)
	try {
		await harness.run("ada")
		const result = await harness.beforeAgentStart()
		assert.ok(result !== undefined)
		assert.ok(result.systemPrompt.startsWith(BASE_PROMPT))
		assert.equal(
			result.systemPrompt,
			`${BASE_PROMPT}\n\n## Session persona: Ada, senior backend engineer\n\n## Role\n\nYou are Ada.\n`,
		)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("no persona selected leaves the base prompt alone", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "body") })
	const harness = setup(workspace)
	try {
		assert.equal(await harness.beforeAgentStart(), undefined)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("an edited persona file applies on the next turn", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "old body") })
	const harness = setup(workspace)
	try {
		await harness.run("ada")
		workspace.write(join(".pi", "personas", "ada.md"), PERSONA_FILE("Ada", "backend", "new body"))
		assert.match((await harness.beforeAgentStart())!.systemPrompt, /new body/)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("a persona file removed after selection stops the injection", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "body") })
	const harness = setup(workspace)
	try {
		await harness.run("ada")
		rmSync(join(workspace.cwd, ".pi", "personas", "ada.md"))
		assert.equal(await harness.beforeAgentStart(), undefined)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("resuming a session restores the persisted persona", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "## Role\n\nYou are Ada.") })
	const harness = setup(workspace, {
		entries: [
			{ type: "custom", customType: PERSONA_ENTRY, data: { id: "ada" } },
			{ type: "message", role: "user" },
		],
	})
	try {
		await harness.start()
		assert.match((await harness.beforeAgentStart())!.systemPrompt, /Session persona: Ada/)
		assert.deepEqual(harness.names, [])
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("the last persisted persona wins and a cleared entry restores nothing", () => {
	assert.equal(
		restorePersonaId([
			{ type: "custom", customType: PERSONA_ENTRY, data: { id: "ada" } },
			{ type: "custom", customType: PERSONA_ENTRY, data: { id: "bob" } },
		]),
		"bob",
	)
	assert.equal(restorePersonaId([{ type: "custom", customType: PERSONA_ENTRY, data: { id: null } }]), undefined)
})

test("an unknown persona is rejected without touching state", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "body") })
	const harness = setup(workspace)
	try {
		await harness.run("marta")
		assert.deepEqual(harness.entries, [])
		assert.deepEqual(harness.names, [])
		assert.equal(harness.notices.at(-1)!.level, "warning")
		assert.match(harness.notices.at(-1)!.message, /Unknown persona: marta\. Available: ada/)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("none clears the persona and stops the injection", async () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada", "backend", "body") })
	const harness = setup(workspace)
	try {
		await harness.run("ada")
		await harness.run("none")
		assert.equal(await harness.beforeAgentStart(), undefined)
		assert.deepEqual(harness.entries.at(-1), { customType: PERSONA_ENTRY, data: { id: null } })
		assert.deepEqual(harness.names, ["Ada"])
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("without persona files the command explains where the template lives", async () => {
	const workspace = makeWorkspace()
	const harness = setup(workspace)
	try {
		await harness.run("")
		assert.equal(harness.notices.at(-1)!.level, "warning")
		assert.match(harness.notices.at(-1)!.message, /No persona files found/)
		assert.ok(harness.notices.at(-1)!.message.includes(TEMPLATE_PATH))
		assert.deepEqual(harness.entries, [])
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("without an argument the selector offers the discovered personas", async () => {
	const workspace = makeWorkspace({
		"ada.md": PERSONA_FILE("Ada", "senior backend engineer", "body"),
		"bob.md": PERSONA_FILE("Bob", "devops", "body"),
	})
	const harness = setup(workspace, { selection: "Bob - devops" })
	try {
		await harness.run("")
		assert.deepEqual(harness.selections.at(-1), ["Ada - senior backend engineer", "Bob - devops", "None"])
		assert.deepEqual(harness.names, ["Bob"])
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("subagent sessions get no persona and no restore", async () => {
	const workspace = makeWorkspace(
		{ "ada.md": PERSONA_FILE("Ada", "backend", "body") },
		{},
	)
	const harness = setup(workspace, {
		child: true,
		entries: [{ type: "custom", customType: PERSONA_ENTRY, data: { id: "ada" } }],
	})
	try {
		await harness.start()
		assert.equal(await harness.beforeAgentStart(), undefined)
	} finally {
		harness.restoreEnv()
		workspace.cleanup()
	}
})

test("arguments resolve by id, by display name, and by clear aliases", () => {
	const workspace = makeWorkspace({ "ada.md": PERSONA_FILE("Ada Lovelace", "backend", "body") })
	try {
		const personas = discoverPersonas(personaRoots(workspace.cwd, { PI_CODING_AGENT_DIR: workspace.agentDir }))
		assert.equal(resolvePersonaArgument("ADA", personas), "ada")
		assert.equal(resolvePersonaArgument("ada lovelace", personas), "ada")
		assert.equal(resolvePersonaArgument("none", personas), null)
		assert.equal(resolvePersonaArgument("neutral", personas), null)
		assert.equal(resolvePersonaArgument("unknown", personas), undefined)
	} finally {
		workspace.cleanup()
	}
})

test("the package ships a structured template and no bundled personas", () => {
	assert.equal(templateExists(), true)
	const template = parsePersonaFile(TEMPLATE_PATH)
	assert.equal(template?.id, "persona-template")
	assert.equal(template?.name, "Ada")
	assert.equal(template?.title, "senior backend engineer")
	assert.match(template!.body, /## Role/)
	assert.match(template!.body, /## Reporting/)
	assert.equal(discoverPersonas([join(TEMPLATE_PATH, "..", "personas")]).length, 0)
})

test("appendPersona separates the block from the base prompt", () => {
	const persona = { id: "ada", name: "Ada", body: "body", path: "/personas/ada.md" }
	assert.equal(appendPersona("base\n\n", persona), "base\n\n## Session persona: Ada\n\nbody\n")
})
