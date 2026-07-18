import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSyntheticGitEnvironment,
	gitRepositoryLocalEnvironmentNames,
	runSyntheticGit,
} from "../helpers/synthetic-git.js";

const targetTest = join(
	import.meta.dir,
	"hermes-structured-host-canary.test.ts",
);

function cleanGit(root: string, ...args: string[]): string {
	const result = runSyntheticGit(root, args, {
		HOME: root,
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
	});
	expect(result.exitCode, args[0] ?? "git").toBe(0);
	return result.stdout.toString().trim();
}

function indexDigest(root: string): string {
	return createHash("sha256")
		.update(readFileSync(join(root, ".git", "index")))
		.digest("hex");
}

test("synthetic Git environment removes Git's complete repository-local variable set", () => {
	const names = gitRepositoryLocalEnvironmentNames();
	const hostile = Object.fromEntries(
		names.map((name) => [name, "outer-repository-sentinel"]),
	);
	const isolated = buildSyntheticGitEnvironment({
		...hostile,
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		CBRAIN_TEST_SENTINEL: "preserved",
	});

	expect(names.length).toBeGreaterThan(0);
	expect(isolated.CBRAIN_TEST_SENTINEL).toBe("preserved");
	for (const name of names) {
		expect(Object.hasOwn(isolated, name), name).toBe(false);
	}
});

test("synthetic repository tests preserve their hook caller repository", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-git-hook-isolation-"));
	const outer = join(root, "outer");
	try {
		mkdirSync(outer);
		writeFileSync(
			join(outer, "sentinel.txt"),
			"outer worktree must remain byte-identical\n",
		);
		cleanGit(outer, "init", "-q");
		cleanGit(outer, "add", "sentinel.txt");
		cleanGit(
			outer,
			"-c",
			"user.name=Anonymous Reviewer",
			"-c",
			"user.email=reviewer@example.invalid",
			"commit",
			"-qm",
			"outer checkpoint",
		);

		const branch = cleanGit(outer, "symbolic-ref", "HEAD");
		const before = {
			head: cleanGit(outer, "rev-parse", "HEAD"),
			branch,
			ref: cleanGit(outer, "rev-parse", branch),
			index: indexDigest(outer),
			worktree: readFileSync(join(outer, "sentinel.txt")),
		};

		const nested = Bun.spawnSync({
			cmd: [
				process.execPath,
				"test",
				targetTest,
				"--test-name-pattern",
				"rejects a clean self-consistent checkout that changed the approved manifest",
			],
			cwd: join(import.meta.dir, "../.."),
			env: {
				HOME: root,
				TMPDIR: root,
				PATH: "/usr/bin:/bin",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				GIT_DIR: join(outer, ".git"),
				GIT_WORK_TREE: ".",
				GIT_INDEX_FILE: join(outer, ".git", "index"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const after = {
			head: cleanGit(outer, "rev-parse", "HEAD"),
			branch: cleanGit(outer, "symbolic-ref", "HEAD"),
			ref: cleanGit(outer, "rev-parse", branch),
			index: indexDigest(outer),
			worktree: readFileSync(join(outer, "sentinel.txt")),
		};

		expect(nested.exitCode).toBe(0);
		expect(after).toEqual(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
