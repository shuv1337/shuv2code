import * as Schema from "effect/Schema";

export class ServerCliCommandExitError extends Schema.TaggedErrorClass<ServerCliCommandExitError>()(
  "ServerCliCommandExitError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerCliDevelopmentIconSourceMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconSourceMissingError>()(
  "ServerCliDevelopmentIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerCliDevelopmentIconTargetMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconTargetMissingError>()(
  "ServerCliDevelopmentIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}
