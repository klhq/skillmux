export type ShellType = "bash" | "zsh" | "fish";

export function generateCompletions(shell: ShellType): string {
  if (shell === "bash") {
    return `# bash completion for skillmux
_skillmux_completions() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    opts="context config calibrate serve index sync init report scan install eval doctor models completions --context --server --json --allow-insecure --verbose --dry-run --help"

    if [ "$COMP_CWORD" -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
        return 0
    fi

    case "$prev" in
        context)
            COMPREPLY=( $(compgen -W "add list current use remove" -- "$cur") )
            ;;
        config)
            COMPREPLY=( $(compgen -W "show get validate diff set status" -- "$cur") )
            ;;
        calibrate)
            COMPREPLY=( $(compgen -W "run list show apply generate-dataset" -- "$cur") )
            ;;
        completions)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
            ;;
    esac
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
        'report:Generate usage stats'
        'scan:Audit skills for issues'
        'install:Install skills into vault'
        'eval:Evaluate search accuracy'
        'doctor:Check runtime health'
        'models:Manage local models'
        'completions:Generate shell completions'
    )
    _describe -t commands 'skillmux command' commands
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
complete -c skillmux -n "__fish_use_subcommand" -a completions -d "Generate shell completions"
`;
  }

  throw new Error(`Unsupported shell: ${shell}`);
}
