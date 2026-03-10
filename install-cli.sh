#!/usr/bin/env bash
set -euo pipefail

# ── Botmem CLI Installer ──────────────────────────────────────────────
# Installs the botmem CLI binary to a target directory and sets up the
# Claude Code skill in the current working directory's .claude/skills/.
#
# Usage:
#   ./install-cli.sh /usr/local/bin          # install to /usr/local/bin
#   ./install-cli.sh ~/bin                   # install to ~/bin
#   ./install-cli.sh                         # defaults to /usr/local/bin

BOTMEM_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${1:-/usr/local/bin}"
SKILL_DIR="${PWD}/.claude/skills/botmem-cli"

# ── 1. Build CLI ──────────────────────────────────────────────────────
echo "Building CLI..."
(cd "$BOTMEM_ROOT" && pnpm --filter @botmem/cli build)

# ── 2. Create wrapper script ─────────────────────────────────────────
# The wrapper calls node with the absolute path to the built CLI,
# so it works from anywhere without npm link or global install.
CLI_JS="${BOTMEM_ROOT}/packages/cli/dist/cli.js"

mkdir -p "$INSTALL_DIR"
cat > "${INSTALL_DIR}/botmem" <<WRAPPER
#!/usr/bin/env bash
exec node "${CLI_JS}" "\$@"
WRAPPER
chmod +x "${INSTALL_DIR}/botmem"

echo "Installed botmem → ${INSTALL_DIR}/botmem"

# ── 3. Verify it's on PATH ───────────────────────────────────────────
if ! command -v botmem &>/dev/null; then
  echo ""
  echo "WARNING: ${INSTALL_DIR} is not on your PATH."
  echo "Add it:  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

# ── 4. Install Claude Code skill (symlink) ───────────────────────────
mkdir -p "$SKILL_DIR"
SKILL_SRC="${BOTMEM_ROOT}/.claude/skills/botmem-cli/SKILL.md"
rm -f "$SKILL_DIR/SKILL.md"
ln -s "$SKILL_SRC" "$SKILL_DIR/SKILL.md"

echo "Linked skill → ${SKILL_DIR}/SKILL.md → ${SKILL_SRC}"

# ── 5. Smoke test ─────────────────────────────────────────────────────
echo ""
echo "Smoke test:"
"${INSTALL_DIR}/botmem" version
echo ""
echo "Done. Next steps:"
echo "  botmem config set-host localhost:12412   # or api.botmem.xyz"
echo "  botmem config set-key bm_sk_...          # store your API key"
echo "  botmem --help                            # see all commands"
