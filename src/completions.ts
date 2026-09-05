import { MANAGED_PINS_AGENT_IDS, SUPPORTED_AGENT_IDS } from "./init-agents";

export type ShellType = "bash" | "zsh" | "fish";

const TOP_LEVEL_COMMANDS: { name: string; description: string }[] = [
  { name: "context", description: "Manage connection contexts" },
  { name: "config", description: "Manage configuration" },
  { name: "serve", description: "Start MCP server" },
  { name: "index", description: "Rebuild local search index" },
  { name: "sync", description: "Synchronize vault skills" },
  { name: "init", description: "Configure this machine and its agents" },
  { name: "project", description: "Configure project-scoped skills" },
  { name: "target", description: "Manage advanced skill-delivery targets" },
  { name: "core", description: "Pin/unpin skills into [core]" },
  { name: "report", description: "Generate usage stats" },
  { name: "scan", description: "Audit skills for issues" },
  { name: "install", description: "Install skills into vault" },
  { name: "eval", description: "Evaluate search accuracy" },
  { name: "doctor", description: "Check runtime health" },
  { name: "skill", description: "Show which root resolves a skill_id" },
  { name: "local-vault", description: "Manage local_vault_paths discoverability markers" },
  { name: "models", description: "Manage local models" },
  { name: "completions", description: "Generate shell completions" },
];

export function generateCompletions(shell: ShellType): string {
  if (shell === "bash") {
    const opts = [...TOP_LEVEL_COMMANDS.map((c) => c.name), "--context", "--server", "--json", "--allow-insecure", "--verbose", "--dry-run", "--help"].join(" ");
    return `# bash completion for skillmux
_skillmux_completions() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    opts="${opts}"

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
        completions)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
            ;;
        core)
            COMPREPLY=( $(compgen -W "pin unpin" -- "$cur") )
            ;;
        skill)
            COMPREPLY=( $(compgen -W "which" -- "$cur") )
            ;;
        project)
            COMPREPLY=( $(compgen -W "init list show add-path remove-path pin unpin attach detach" -- "$cur") )
            ;;
        target)
            COMPREPLY=( $(compgen -W "list show add remove" -- "$cur") )
            ;;
        local-vault)
            COMPREPLY=( $(compgen -W "init" -- "$cur") )
            ;;
        eval)
            COMPREPLY=( $(compgen -W "promote" -- "$cur") )
            ;;
        --agent)
            if [ "\${COMP_WORDS[1]}" = "project" ]; then
                COMPREPLY=( $(compgen -W "${MANAGED_PINS_AGENT_IDS.join(" ")}" -- "$cur") )
            else
                COMPREPLY=( $(compgen -W "${SUPPORTED_AGENT_IDS.join(" ")}" -- "$cur") )
            fi
            ;;
    esac
    if [ "\${COMP_WORDS[1]}" = "init" ] && [ "\${#COMPREPLY[@]}" -eq 0 ]; then
        COMPREPLY=( $(compgen -W "--agent --vault --core --migrate-full-vault --show-mcp-setup --register-mcp --no-instructions --no-sync --interactive --yes --dry-run --json" -- "$cur") )
    fi
    if [ "\${COMP_WORDS[1]}" = "project" ] && [ "\${COMP_WORDS[2]}" = "init" ]; then
        COMPREPLY=( $(compgen -W "--name --skill --agent --target --register-mcp --no-sync --interactive --yes --dry-run --json" -- "$cur") )
    fi
    if [ "\${COMP_WORDS[1]}" = "eval" ] && [ "\${COMP_WORDS[2]}" = "promote" ]; then
        COMPREPLY=( $(compgen -W "--since --out --dry-run --yes --json" -- "$cur") )
    fi
}
complete -F _skillmux_completions skillmux
`;
  }

  if (shell === "zsh") {
    const commands = TOP_LEVEL_COMMANDS.map((c) => `        '${c.name}:${c.description}'`).join("\n");
    return `#compdef skillmux
_skillmux() {
    local -a commands
    commands=(
${commands}
    )
    if (( CURRENT == 2 )); then
        _describe -t commands 'skillmux command' commands
    elif [[ "$words[2]" == "init" ]]; then
        _arguments \\
          '*--agent[select an agent]:agent:(${SUPPORTED_AGENT_IDS.join(" ")})' \\
          '--vault[vault directory]:directory:_directories' \\
          '*--core[seed a core skill]:skill id:' \\
          '--migrate-full-vault[convert a full-vault symlink to managed pins]' \\
          '--show-mcp-setup[also print the MCP registration snippet]' \\
          '--register-mcp[register skillmux via the agent own CLI]' \\
          '--no-instructions[skip managed instruction files]' \\
          '--no-sync[save setup without synchronizing targets]' \\
          '--interactive[force guided setup]' \\
          '--yes[apply without prompts]' \\
          '--dry-run[print the plan without writing]' \\
          '--json[emit a JSON envelope]'
    elif [[ "$words[2]" == "project" && "$words[3]" == "init" ]]; then
        _arguments \\
          '1:project directory:_directories' \\
          '--name[project group name]:group:' \\
          '*--skill[project skill]:skill id:' \\
          '*--agent[select an agent]:agent:(${MANAGED_PINS_AGENT_IDS.join(" ")})' \\
          '*--target[select an advanced target]:target:' \\
          '--register-mcp[register a project-scoped MCP server for claude-code]' \\
          '--no-sync[save setup without synchronizing targets]' \\
          '--interactive[force guided setup]' \\
          '--yes[apply without prompts]' \\
          '--dry-run[print the plan without writing]' \\
          '--json[emit a JSON envelope]'
    elif [[ "$words[2]" == "project" && CURRENT == 3 ]]; then
        _values 'project command' init list show add-path remove-path pin unpin attach detach
    elif [[ "$words[2]" == "eval" && "$words[3]" == "promote" ]]; then
        _arguments \
          '--since[time window]:window:' \
          '--out[output file]:file:_files' \
          '--dry-run[print the plan without writing]' \
          '--yes[apply without prompts]' \
          '--json[emit a JSON envelope]'
    elif [[ "$words[2]" == "eval" && CURRENT == 3 ]]; then
        _values 'eval command' promote
    elif [[ "$words[2]" == "target" && CURRENT == 3 ]]; then
        _values 'target command' list show add remove rehome migrate
    elif [[ "$words[2]" == "skill" && CURRENT == 3 ]]; then
        _values 'skill command' which
    elif [[ "$words[2]" == "core" && CURRENT == 3 ]]; then
        _values 'core command' pin unpin
    elif [[ "$words[2]" == "local-vault" && CURRENT == 3 ]]; then
        _values 'local-vault command' init
    fi
}
_skillmux "$@"
`;
  }

  if (shell === "fish") {
    const topLevel = TOP_LEVEL_COMMANDS.map(
      (c) => `complete -c skillmux -n "__fish_use_subcommand" -a ${c.name} -d "${c.description}"`,
    ).join("\n");
    return `# fish completion for skillmux
complete -c skillmux -f
${topLevel}
complete -c skillmux -n "__fish_seen_subcommand_from init" -l agent -x -a "${SUPPORTED_AGENT_IDS.join(" ")}" -d "Select an agent"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l vault -r -d "Vault directory"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l core -x -d "Seed a core skill"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l migrate-full-vault -d "Convert a full-vault symlink"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l show-mcp-setup -d "Also print the MCP registration snippet"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l register-mcp -d "Register skillmux via the agent's own CLI"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l no-instructions -d "Skip managed instruction files"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l no-sync -d "Save without synchronizing"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l interactive -d "Force guided setup"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l yes -d "Apply without prompts"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l dry-run -d "Print the plan without writing"
complete -c skillmux -n "__fish_seen_subcommand_from init" -l json -d "Emit a JSON envelope"
complete -c skillmux -n "__fish_seen_subcommand_from project" -a "init list show add-path remove-path pin unpin attach detach" -d "Manage projects"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l name -x -d "Project group name"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l skill -x -d "Project skill"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l agent -x -a "${MANAGED_PINS_AGENT_IDS.join(" ")}" -d "Select an agent"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l target -x -d "Select an advanced delivery target"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l register-mcp -d "Register a project-scoped MCP server for claude-code"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l no-sync -d "Save without synchronizing"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l interactive -d "Force guided setup"
complete -c skillmux -n "__fish_seen_subcommand_from project" -l yes -d "Apply without prompts"
complete -c skillmux -n "__fish_seen_subcommand_from eval" -a "promote" -d "Promote correlated fetches into eval cases"
complete -c skillmux -n "__fish_seen_subcommand_from eval; and __fish_seen_subcommand_from promote" -l since -x -d "Time window"
complete -c skillmux -n "__fish_seen_subcommand_from eval; and __fish_seen_subcommand_from promote" -l out -r -d "Output file"
complete -c skillmux -n "__fish_seen_subcommand_from eval; and __fish_seen_subcommand_from promote" -l dry-run -d "Print the plan without writing"
complete -c skillmux -n "__fish_seen_subcommand_from eval; and __fish_seen_subcommand_from promote" -l yes -d "Apply without prompts"
complete -c skillmux -n "__fish_seen_subcommand_from eval; and __fish_seen_subcommand_from promote" -l json -d "Emit a JSON envelope"
complete -c skillmux -n "__fish_seen_subcommand_from target" -a "list show add remove rehome migrate" -d "Manage targets"
complete -c skillmux -n "__fish_seen_subcommand_from core" -a "pin unpin" -d "Manage [core] pins"
complete -c skillmux -n "__fish_seen_subcommand_from skill" -a "which" -d "Show which root resolves a skill_id"
complete -c skillmux -n "__fish_seen_subcommand_from local-vault" -a "init" -d "Initialize a local_vault_paths marker"
`;
  }

  throw new Error(`Unsupported shell: ${shell}`);
}
