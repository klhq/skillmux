export type ShellType = "bash" | "zsh" | "fish";

export function generateCompletions(shell: ShellType): string {
  if (shell === "bash") {
    return `# bash completion for skillmux
_skillmux_completions() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    opts="context config calibrate serve index sync init project report scan install eval doctor which manifest local-vault models completions --context --server --json --allow-insecure --verbose --dry-run --help"

    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
        return 0
    fi

    case "$prev" in
        context)
            COMPREPLY=( $(compgen -W "add list current use remove" -- "$cur") )
            ;;
        config)
            COMPREPLY=( $(compgen -W "init show get validate diff set status" -- "$cur") )
            ;;
        calibrate)
            COMPREPLY=( $(compgen -W "run list show apply generate-dataset" -- "$cur") )
            ;;
        completions)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
            ;;
        manifest)
            COMPREPLY=( $(compgen -W "pin unpin" -- "$cur") )
            ;;
        project)
            COMPREPLY=( $(compgen -W "init list show add-path remove-path pin unpin attach detach" -- "$cur") )
            ;;
        local-vault)
            COMPREPLY=( $(compgen -W "init" -- "$cur") )
            ;;
        --client)
            COMPREPLY=( $(compgen -W "claude-code codex gemini-cli opencode github-copilot windsurf antigravity goose hermes skillmux-mcp" -- "$cur") )
            ;;
        --target)
            COMPREPLY=( $(compgen -W "agent-skills claude-code codex custom" -- "$cur") )
            ;;
    esac
    if [ "\${COMP_WORDS[1]}" = "init" ] && [ "\${#COMPREPLY[@]}" -eq 0 ]; then
        COMPREPLY=( $(compgen -W "--client --target --path --vault --core --migrate-full-vault --no-instructions --no-sync --interactive --yes --dry-run --json" -- "$cur") )
    fi
    if [ "\${COMP_WORDS[1]}" = "project" ] && [ "\${COMP_WORDS[2]}" = "init" ]; then
        COMPREPLY=( $(compgen -W "--name --skill --client --target --no-sync --interactive --yes --dry-run --json" -- "$cur") )
    fi
}
complete -F _skillmux_completions skillmux
`;
  }

  if (shell === "zsh") {
    return `#compdef skillmux
_skillmux() {
    local -a commands
    commands=(
        'context:Manage connection contexts'
        'config:Manage configuration'
        'calibrate:Manage policy calibration'
        'serve:Start MCP server'
        'index:Rebuild local search index'
        'sync:Synchronize vault skills'
        'init:Initialize project targets'
        'project:Configure project-scoped skills'
        'report:Generate usage stats'
        'scan:Audit skills for issues'
        'install:Install skills into vault'
        'eval:Evaluate search accuracy'
        'doctor:Check runtime health'
        'which:Show which root resolves a skill_id'
        'manifest:Pin/unpin skills into [core] or [project.*]'
        'local-vault:Manage local_vault_paths discoverability markers'
        'models:Manage local models'
        'completions:Generate shell completions'
    )
    if (( CURRENT == 2 )); then
        _describe -t commands 'skillmux command' commands
    elif [[ "$words[2]" == "init" ]]; then
        _arguments \
          '*--client[select a client]:client:(claude-code codex gemini-cli opencode github-copilot windsurf antigravity goose hermes skillmux-mcp)' \
          '*--target[select a target]:target:(agent-skills claude-code codex custom)' \
          '--path[custom target directory]:directory:_directories' \
          '--vault[vault directory]:directory:_directories' \
          '*--core[seed a core skill]:skill id:' \
          '--migrate-full-vault[convert a full-vault symlink to managed pins]' \
          '--no-instructions[skip managed instruction files]' \
          '--no-sync[save setup without synchronizing targets]' \
          '--interactive[force guided setup]' \
          '--yes[apply without prompts]' \
          '--dry-run[print the plan without writing]' \
          '--json[emit a JSON envelope]'
    elif [[ "$words[2]" == "project" && "$words[3]" == "init" ]]; then
        _arguments \
          '1:project directory:_directories' \
          '--name[project group name]:group:' \
          '*--skill[project skill]:skill id:' \
          '*--client[select a client]:client:(claude-code codex gemini-cli opencode github-copilot windsurf antigravity)' \
          '*--target[select an advanced target]:target:' \
          '--no-sync[save setup without synchronizing targets]' \
          '--interactive[force guided setup]' \
          '--yes[apply without prompts]' \
          '--dry-run[print the plan without writing]' \
          '--json[emit a JSON envelope]'
    elif [[ "$words[2]" == "project" && CURRENT == 3 ]]; then
        _values 'project command' init list show add-path remove-path pin unpin attach detach
    fi
}
_skillmux "$@"
`;
  }

  if (shell === "fish") {
    return `# fish completion for skillmux
complete -c skillmux -f
complete -c skillmux -n "__fish_use_subcommand" -a context -d "Manage connection contexts"
complete -c skillmux -n "__fish_use_subcommand" -a config -d "Manage configuration"
complete -c skillmux -n "__fish_use_subcommand" -a calibrate -d "Manage policy calibration"
complete -c skillmux -n "__fish_use_subcommand" -a serve -d "Start MCP server"
complete -c skillmux -n "__fish_use_subcommand" -a init -d "Configure this machine and its clients"
complete -c skillmux -n "__fish_use_subcommand" -a project -d "Configure project-scoped skills"
complete -c skillmux -n "__fish_use_subcommand" -a completions -d "Generate shell completions"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l client -x -a "claude-code codex gemini-cli opencode github-copilot windsurf antigravity goose hermes skillmux-mcp" -d "Select a client"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l target -x -a "agent-skills claude-code codex custom" -d "Select a target"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l path -r -d "Custom target directory"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l vault -r -d "Vault directory"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l core -x -d "Seed a core skill"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l migrate-full-vault -d "Convert a full-vault symlink"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l no-instructions -d "Skip managed instruction files"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l no-sync -d "Save without synchronizing"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l interactive -d "Force guided setup"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l yes -d "Apply without prompts"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l dry-run -d "Print the plan without writing"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l json -d "Emit a JSON envelope"
complete -c skillmux -n "__fish_seen_subcommand_from project" -a "init list show add-path remove-path pin unpin attach detach" -d "Manage projects"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l name -x -d "Project group name"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l skill -x -d "Project skill"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l client -x -a "claude-code codex gemini-cli opencode github-copilot windsurf antigravity" -d "Select a client"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l target -x -d "Select an advanced target"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l no-sync -d "Save without synchronizing"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l interactive -d "Force guided setup"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l yes -d "Apply without prompts"
`;
  }

  throw new Error(`Unsupported shell: ${shell}`);
}
