# mend

`mend` is a command-line tool that applies edits written by AI models to a tree of text files. It reads four edit formats, finds the lines each edit names even when their whitespace or indentation drifted, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format).
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (no whitespace-tolerant matching).
- Options and `PATCH` may come in any order. `--` ends the options.

Node 22 and its standard library only; nothing is installed before the program runs.

## Formats

- **Unified diffs** — `diff --git` sections and `---`/`+++` headers with `@@` hunks. Line numbers in hunks are treated as hints: hunks are matched against the file's lines, nearest to the hinted position.
- **SEARCH/REPLACE blocks** — a file path followed by `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`, `*** Delete File:` and `*** Update File:` sections, including `*** Move to:` and `@@` anchored chunks.
- **JSON edits** — one JSON array of edit objects, or JSON Lines with one edit object per line: `create`, `str_replace` and `insert` commands.

## Matching

Old lines are found at the first of three tiers at which they occur: exact match, trailing-whitespace-insensitive match, then leading-and-trailing-whitespace-insensitive match (with new lines re-indented to the file's indentation). `--strict` restricts matching to the exact tier.

## Output and exit codes

- Exit `0`: the tree was written. One line per changed path (`A <path>`, `D <path>`, `M <path>`, `R <old> -> <new>` for moves), then `ok: <n> files`.
- Exit `1`: some edits failed. One `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`. No file is written.
- Exit `2`: usage, unreadable patch file, undetectable format, or unparsable patch (`error: usage`, `error: no-patch`, `error: format`, `error: parse <N>`).

All edits apply in patch order to the tree as earlier edits left it. A failed edit changes nothing, and the edits after it still run, so every failure is reported. Paths must be safe (relative, no empty, `.` or `..` segments, no backslashes).

## Files

- `main.ts` — the CLI.
- `runner.ts` — trial harness: when `MAKEFUN_ENV_URL` is set, reads checks from the environment, runs `main.ts` on each, and posts the results.

## License

MIT — see `LICENSE`.
