type Environment = Readonly<Record<string, string | undefined>>;

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
		names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))
	) {
		throw new Error(
			"Git returned an invalid repository-local environment variable list",
		);
	}
	return [...new Set(names)];
}

export function buildSyntheticGitEnvironment(
	environment: Environment = process.env,
): Record<string, string> {
	const isolated = definedEnvironment(environment);
	for (const name of gitRepositoryLocalEnvironmentNames(environment)) {
		delete isolated[name];
	}
	return isolated;
}

export function runSyntheticGit(
	cwd: string,
	args: readonly string[],
	environment: Environment = process.env,
) {
	return Bun.spawnSync({
		cmd: ["git", ...args],
		cwd,
		env: buildSyntheticGitEnvironment(environment),
		stdout: "pipe",
		stderr: "pipe",
	});
}
