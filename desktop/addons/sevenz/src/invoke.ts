type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn {
  const internals = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
    | { invoke: InvokeFn }
    | undefined;
  if (internals?.invoke) {
    return internals.invoke.bind(internals);
  }
  throw new Error("Tauri invoke が利用できません。shirube-filer 内でのみ動作します。");
}

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runExternalCommand(
  program: string,
  args: string[],
  cwd?: string
): Promise<CommandResult> {
  const invoke = getInvoke();
  return invoke("run_external_command", {
    program,
    args,
    cwd: cwd ?? null,
  }) as Promise<CommandResult>;
}
