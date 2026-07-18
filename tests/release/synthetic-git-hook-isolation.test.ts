import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
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
	expect(isolated.GIT_CONFIG_NOSYSTEM).toBe("1");
	expect(isolated.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	expect(isolated.GIT_DEFAULT_HASH).toBe("sha1");
	for (const name of names) {
		expect(Object.hasOwn(isolated, name), name).toBe(false);
	}
});

test("synthetic repository tests preserve their hook caller repository", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-git-hook-isolation-"));
	const outer = join(root, "outer");
	const inner = join(root, "inner");
	try {
		mkdirSync(outer);
		mkdirSync(inner);
		writeFileSync(
			join(outer, "sentinel.txt"),
			"outer worktree must remain byte-identical\n",
		);
		writeFileSync(join(inner, "fixture.txt"), "synthetic repository content\n");
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

		const hooks = join(root, "hooks");
		const hookMarker = join(root, "hook-ran");
		const globalConfig = join(root, "hostile-global-config");
		mkdirSync(hooks);
		writeFileSync(
			join(hooks, "pre-commit"),
			`#!/bin/sh\nprintf triggered > "${hookMarker}"\nexit 91\n`,
		);
		chmodSync(join(hooks, "pre-commit"), 0o755);
		writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);

		const hostileEnvironment = {
			HOME: root,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			GIT_DIR: join(outer, ".git"),
			GIT_WORK_TREE: ".",
			GIT_INDEX_FILE: join(outer, ".git", "index"),
			GIT_OBJECT_DIRECTORY: join(outer, ".git", "objects"),
			GIT_COMMON_DIR: join(outer, ".git"),
			GIT_CONFIG_GLOBAL: globalConfig,
			GIT_CONFIG_NOSYSTEM: "0",
			GIT_DEFAULT_HASH: "sha256",
		};
		const runInnerGit = (...args: string[]) => {
			const result = runSyntheticGit(inner, args, hostileEnvironment);
			expect(result.exitCode, args[0] ?? "git").toBe(0);
			return result.stdout.toString().trim();
		};
		runInnerGit("init", "-q");
		runInnerGit("add", "fixture.txt");
		runInnerGit(
			"-c",
			"user.name=Anonymous Reviewer",
			"-c",
			"user.email=reviewer@example.invalid",
			"commit",
			"-qm",
			"synthetic checkpoint",
		);
		const innerHead = runInnerGit("rev-parse", "HEAD");

		const after = {
			head: cleanGit(outer, "rev-parse", "HEAD"),
			branch: cleanGit(outer, "symbolic-ref", "HEAD"),
			ref: cleanGit(outer, "rev-parse", branch),
			index: indexDigest(outer),
			worktree: readFileSync(join(outer, "sentinel.txt")),
		};

		expect(innerHead).toMatch(/^[a-f0-9]{40}$/);
		expect(existsSync(join(inner, ".git"))).toBe(true);
		expect(existsSync(hookMarker)).toBe(false);
		expect(after).toEqual(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
