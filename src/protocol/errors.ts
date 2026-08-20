export class ProtocolJsonError extends Error {
  readonly code = "RUNTIME_JSON_INVALID";

  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(offset === undefined ? message : `${message} at byte ${offset}`);
    this.name = "ProtocolJsonError";
  }
}
