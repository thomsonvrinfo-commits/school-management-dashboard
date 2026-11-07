export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** The input field this error is about (Slice 2): lets a form put the message next to the right box. */
  readonly field: string | undefined;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
