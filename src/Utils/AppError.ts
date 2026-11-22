export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
  }
}
