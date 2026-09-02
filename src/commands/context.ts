import {
  addContext,
  getCurrentContext,
  listContexts,
  removeContext,
  useContext,
  type ResolvedContext,
} from "../context";
import {
  emitSuccess,
  renderTable,
  renderContextBanner,
  unknownSubcommandError,
} from "../output";

export async function handleContextCommand(
  sub: string,
  args: string[],
  ctx: { context: ResolvedContext; isJson: boolean },
) {
  if (sub === "list") {
    const contexts = await listContexts();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, contexts, () => {
      renderContextBanner(ctx.context);
      renderTable(
        [
          { key: "name", header: "NAME" },
          { key: "server", header: "SERVER" },
          { key: "token_env", header: "TOKEN_ENV" },
          { key: "isDefault", header: "DEFAULT" },
        ],
        contexts.map((c) => ({
          ...c,
          token_env: c.token_env ?? "-",
          isDefault: c.isDefault ? "*" : "",
        })),
      );
    });
    return;
  }

  if (sub === "current") {
    const current = await getCurrentContext();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, current, () => {
      renderContextBanner(ctx.context);
      console.log(`Current context: ${current.name} (${current.server})`);
    });
    return;
  }

  if (sub === "add") {
    const name = args[0];
    let server: string | undefined;
    let tokenEnv: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--server") server = args[++i];
      else if (args[i] === "--token-env") tokenEnv = args[++i];
    }
    if (!name || !server) {
      throw new Error(
        "usage: skillmux context add <name> --server <url> [--token-env <env_name>]",
      );
    }
    await addContext(name, { server, token_env: tokenEnv });
    emitSuccess(
      { isJson: ctx.isJson, context: ctx.context },
      { name, server, token_env: tokenEnv },
      () => {
        console.log(`Added context "${name}" -> ${server}`);
      },
    );
    return;
  }

  if (sub === "use") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context use <name>");
    await useContext(name);
    emitSuccess(
      { isJson: ctx.isJson, context: ctx.context },
      { default_context: name },
      () => {
        console.log(`Switched default context to "${name}"`);
      },
    );
    return;
  }

  if (sub === "remove") {
    const name = args[0];
    if (!name) throw new Error("usage: skillmux context remove <name>");
    await removeContext(name);
    emitSuccess(
      { isJson: ctx.isJson, context: ctx.context },
      { removed: name },
      () => {
        console.log(`Removed context "${name}"`);
      },
    );
    return;
  }

  throw unknownSubcommandError("context", sub, ["add", "list", "current", "use", "remove"]);
}
