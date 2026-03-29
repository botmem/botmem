---
name: push-and-babysit
description: Push code changes and monitor CI/CD pipeline until all checks pass. Automatically fixes any failing checks and re-pushes. Use this skill whenever the user says "push", "push and babysit", "babysit CI", "push and watch", "deploy", "ship it", "push and fix CI", or any variation of wanting to commit, push, and ensure CI passes. Also trigger when the user wants to monitor a pipeline after pushing, or when they want autonomous CI fixing. This skill is persistent — it never gives up until CI is green.
---

# Push and Babysit

Autonomous push-fix-push loop that commits, pushes, monitors CI, and fixes failures until all checks pass.

## Why this exists

Pushing code and waiting for CI is tedious. When CI fails, the cause might be your changes, a flaky test, a pre-existing issue, or an environment problem. This skill handles ALL of those — it doesn't care who caused the failure, it just fixes it and pushes again.

## Workflow

```
commit → push → monitor CI → [pass? done!] → [fail? fix → commit → push → monitor CI → ...]
```

### Phase 1: Commit and Push

1. Run `git status` to see all changes (never use `-uall` flag)
2. Run `git diff --stat` to understand scope of changes
3. Run `git log --oneline -5` to match commit message style
4. Stage specific files (NEVER use `git add -A` or `git add .`)
5. Create commit with descriptive message using HEREDOC format:
   ```bash
   git commit -m "$(cat <<'EOF'
   Your commit message here
   EOF
   )"
   ```
6. Push to remote: `git push origin <branch>`

Important commit rules:

- Never skip hooks (`--no-verify`)
- Never amend existing commits — always create NEW commits
- If pre-commit hook fails, fix the issue and create a new commit
- Don't commit sensitive files (.env, credentials, etc.)

### Phase 2: Monitor CI

After pushing, monitor the pipeline:

```bash
# Wait for run to appear (may take a few seconds)
sleep 3

# Get the latest run
gh run list --limit 1 --json databaseId,status,conclusion,name,headBranch

# Watch it in real-time
gh run watch <run-id>
```

If `gh run watch` isn't available or times out, poll with:

```bash
gh run view <run-id> --json status,conclusion,jobs
```

### Phase 3: Handle Failures

When ANY job fails — even one — you are not done. Do not classify failures as "pre-existing" or "unrelated" and move on. Every red job is your problem. The only acceptable outcome is every single job green.

1. **Get the failure details:**

   ```bash
   gh run view <run-id> --log-failed
   ```

2. **Diagnose the root cause.** Common categories:
   - **Lint errors**: Run the linter locally, fix violations
   - **Type errors**: Run `tsc` locally, fix type issues
   - **Test failures**: Run the failing test locally, fix the test or the code
   - **Build failures**: Run the build locally, fix compilation issues
   - **Flaky tests**: If a test passes locally but fails in CI, check for timing/env issues
   - **Pre-existing failures**: If the failure is in code you didn't touch, fix it anyway
   - **Workflow/config failures**: If a job fails due to missing permissions, bad workflow YAML, expired secrets, or infrastructure config — fix the workflow file, permissions block, or config. These are code changes like any other (usually in `.github/workflows/`). Common examples:
     - Missing `permissions:` block (add `contents: write`, `workflows: write`, etc.)
     - Expired or missing secrets (tell the user what secret to add in repo settings)
     - Wrong action versions or deprecated syntax (update the workflow YAML)

3. **Fix the issue locally.** Run the relevant check locally to confirm the fix:

   ```bash
   pnpm lint          # for lint failures
   pnpm exec tsc -b   # for type errors
   pnpm test          # for test failures
   pnpm build         # for build failures
   ```

   For workflow/config fixes that can't be tested locally, read the error message carefully, apply the fix to the workflow YAML, and push — CI itself is the test.

4. **Commit the fix** with a descriptive message explaining what was fixed:

   ```bash
   git commit -m "$(cat <<'EOF'
   fix(ci): resolve CI failure — [description of what was wrong]
   EOF
   )"
   ```

5. **Push again** and return to Phase 2.

### Phase 4: Success

"All checks pass" means literally every job in the workflow run has conclusion `success` or `skipped`. If even one job has conclusion `failure`, you are NOT done — go back to Phase 3.

Do not rationalize failures away. "The jobs that matter passed" is not green. "Pre-existing issue" is not green. "Infrastructure problem" is not green. Only all-green is green.

When truly all jobs pass:

- Report the green status
- Include the run URL: `gh run view <run-id> --json url`
- Mention how many push cycles it took

## Recursive Self-Invocation

This skill is designed to be persistent. The loop structure is:

```
function pushAndBabysit():
    commit_and_push()
    result = monitor_ci()
    if result == "success":
        report_success()
        return
    else:
        diagnose_failure()
        fix_issue()
        pushAndBabysit()  // recurse
```

There is no maximum retry limit. Keep going until CI is green. Each iteration should:

- Fix the CURRENT failure (not guess at future ones)
- Verify the fix locally before pushing
- Create a new commit (never amend)

## Edge Cases

- **Multiple failing jobs**: Fix them one at a time, starting with the one most likely to unblock others (usually lint → types → build → test)
- **CI is still running**: Wait for it. Use `gh run watch` or poll every 30 seconds
- **No CI workflow**: Tell the user there's no CI configured
- **Push rejected**: Pull first (`git pull --rebase origin <branch>`), resolve conflicts, then push
- **Rate limits**: If `gh` commands fail with rate limits, wait 60 seconds and retry
- **Workflow permissions errors** (e.g., `refusing to allow a GitHub App to create or update workflow`): This means the `GITHUB_TOKEN` lacks required permissions. Fix by adding/updating the `permissions:` block in the workflow YAML file. If the fix requires a PAT or repo secret the user must configure, tell them exactly what to do and wait — but still treat this as a failure to fix, not an acceptable state.
- **Secrets/token issues**: If a job fails because a secret is missing or expired, tell the user what secret to add in GitHub repo settings (Settings → Secrets → Actions), then wait for them to confirm before re-pushing.
