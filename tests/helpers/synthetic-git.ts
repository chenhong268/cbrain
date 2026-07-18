type Environment = Readonly<Record<string, string | undefined>>;

const KNOWN_REPOSITORY_LOCAL_ENVIRONMENT_NAMES = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_INTERNAL_SUPER_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
] as const;

const MINIMUM_REPORTED_NAMES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_COMMON_DIR",
] as const;

function isGitConfigControl(name: string): boolean {
	return name === "GIT_CONFIG" || name.startsWith("GIT_CONFIG_");
}

function definedEnvironment(environment: Environment): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

export function gitRepositoryLocalEnvironmentNames(
	environment: Environment = process.env,
): string[] {
	const probe = Bun.spawnSync({
		cmd: ["git", "rev-parse", "--local-env-vars"],
		env: {
			HOME: environment.HOME ?? "/tmp",
			PATH: environment.PATH ?? "/usr/bin:/bin",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (probe.exitCode !== 0) {
		throw new Error(
			"Unable to enumerate Git repository-local environment variables",
		);
	}

	const names = probe.stdout
		.toString()
		.split("\n")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	if (
		names.length === 0 ||
		names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name)) ||
		MINIMUM_REPORTED_NAMES.some((name) => !names.includes(name))
	) {
		throw new Error(
			"Git returned an invalid repository-local environment variable list",
		);
	}
	return [...new Set([...KNOWN_REPOSITORY_LOCAL_ENVIRONMENT_NAMES, ...names])];
}

export function buildSyntheticGitEnvironment(
	environment: Environment = process.env,
): Record<string, string> {
	const isolated = definedEnvironment(environment);
	for (const name of gitRepositoryLocalEnvironmentNames(environment)) {
		delete isolated[name];
	}
	for (const name of Object.keys(isolated)) {
		if (isGitConfigControl(name)) delete isolated[name];
	}
	isolated.GIT_CONFIG_NOSYSTEM = "1";
	isolated.GIT_CONFIG_GLOBAL = "/dev/null";
	isolated.GIT_DEFAULT_HASH = "sha1";
	return isolated;
}

export function runSyntheticGit(
	cwd: string,
	args: readonly string[],
	environment: Environment = process.env,
) {
	return Bun.spawnSync({
		cmd: ["git", "-c", "core.hooksPath=/dev/null", ...args],
		cwd,
		env: buildSyntheticGitEnvironment(environment),
		stdout: "pipe",
		stderr: "pipe",
	});
}
